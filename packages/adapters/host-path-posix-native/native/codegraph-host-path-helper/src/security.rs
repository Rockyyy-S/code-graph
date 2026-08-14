use std::{
    collections::{HashMap, VecDeque},
    io::Read,
};

#[cfg(target_os = "linux")]
use std::fs::File;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::{
    canonical::{canonical_json, canonical_sha256},
    protocol::{
        ABI_VERSION, AuthenticatedRequestEnvelopeV1, AuthenticatedRequestV1, BridgeCandidateV1,
        HelperError, INSTALL_PROVENANCE_SCHEMA_VERSION, InstallProvenanceV2, MAX_BATCH_BYTES,
        MAX_CANDIDATES, MAX_DEADLINE_WINDOW_MS, MAX_PATH_BYTES, PROTOCOL_VERSION,
        PeerIdentityV1, ProvenancePayloadV2,
    },
};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedPeerV1 {
    pub gid: u32,
    pub mount_namespace_inode: u64,
    pub pid: u32,
    pub start_time_ticks: u64,
    pub uid: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedRootV1 {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: u64,
    pub mount_id: u64,
}

#[derive(Clone)]
pub struct SecurityPolicyV1 {
    pub boot_id: String,
    pub daemon_epoch: String,
    pub expected_provenance: InstallProvenanceV2,
    pub install_public_key: VerifyingKey,
    pub max_clock_skew_ms: u64,
    pub transcript_key: Vec<u8>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PeerKey {
    gid: u32,
    mount_namespace_inode: u64,
    uid: u32,
}

#[derive(Clone, Debug)]
struct ReplayEntry {
    deadline_unix_ms: u64,
    digest: String,
    key: PeerKey,
    nonce: String,
    sequence: u64,
}

/// 有界 replay cache 同时锁定 nonce/request digest 与每个真实 peer 的严格递增 sequence。
pub struct ReplayCache {
    capacity: usize,
    entries: VecDeque<ReplayEntry>,
    latest_sequence: HashMap<PeerKey, u64>,
}

impl ReplayCache {
    pub fn new(capacity: usize) -> Result<Self, HelperError> {
        if capacity == 0 || capacity > 65_536 {
            return Err(HelperError::budget("REPLAY_CAPACITY"));
        }
        Ok(Self { capacity, entries: VecDeque::new(), latest_sequence: HashMap::new() })
    }

    pub fn consume(
        &mut self,
        request: &AuthenticatedRequestEnvelopeV1,
        now_unix_ms: u64,
    ) -> Result<(), HelperError> {
        self.prune(now_unix_ms);
        let key = PeerKey {
            gid: request.request.peer.gid,
            mount_namespace_inode: request.request.mount_namespace.inode,
            uid: request.request.peer.uid,
        };
        if self.entries.iter().any(|entry| {
            entry.nonce == request.request.nonce || entry.digest == request.request_digest
        }) {
            return Err(HelperError::replay("REPLAY_DUPLICATE"));
        }
        if self.latest_sequence.get(&key).is_some_and(|latest| request.request.sequence <= *latest) {
            return Err(HelperError::replay("SEQUENCE_NOT_MONOTONIC"));
        }
        if self.entries.len() >= self.capacity {
            return Err(HelperError::budget("REPLAY_CACHE_FULL"));
        }
        self.latest_sequence.insert(key.clone(), request.request.sequence);
        self.entries.push_back(ReplayEntry {
            deadline_unix_ms: request.request.deadline_unix_ms,
            digest: request.request_digest.clone(),
            key,
            nonce: request.request.nonce.clone(),
            sequence: request.request.sequence,
        });
        Ok(())
    }

    fn prune(&mut self, now_unix_ms: u64) {
        while self.entries.front().is_some_and(|entry| entry.deadline_unix_ms < now_unix_ms) {
            self.entries.pop_front();
        }
        self.latest_sequence.clear();
        for entry in &self.entries {
            self.latest_sequence
                .entry(entry.key.clone())
                .and_modify(|value| *value = (*value).max(entry.sequence))
                .or_insert(entry.sequence);
        }
    }
}

/// 完整验证协议、认证、peer、namespace、root/volume、deadline 与 provenance。
pub fn validate_authenticated_request(
    envelope: &AuthenticatedRequestEnvelopeV1,
    policy: &SecurityPolicyV1,
    observed_peer: &ObservedPeerV1,
    observed_root: &ObservedRootV1,
    now_unix_ms: u64,
) -> Result<(), HelperError> {
    let request = &envelope.request;
    validate_request_shape(request)?;
    if envelope.request_digest != canonical_sha256(request)? {
        return Err(HelperError::authentication("REQUEST_DIGEST_MISMATCH"));
    }
    verify_transcript_mac(
        &policy.transcript_key,
        &RequestMacBody { request, request_digest: &envelope.request_digest },
        &envelope.transcript_mac,
    )?;
    if request.boot_id != policy.boot_id || request.daemon_epoch != policy.daemon_epoch {
        return Err(HelperError::namespace("BOOT_OR_DAEMON_EPOCH_DRIFT"));
    }
    if request.issued_at_unix_ms > now_unix_ms.saturating_add(policy.max_clock_skew_ms) {
        return Err(HelperError::deadline("ISSUED_AT_IN_FUTURE"));
    }
    if request.deadline_unix_ms < now_unix_ms {
        return Err(HelperError::deadline("REQUEST_EXPIRED"));
    }
    if request.deadline_unix_ms.saturating_sub(request.issued_at_unix_ms) > MAX_DEADLINE_WINDOW_MS {
        return Err(HelperError::deadline("DEADLINE_WINDOW_EXCEEDED"));
    }
    let claimed_peer = &request.peer;
    if claimed_peer.uid != observed_peer.uid ||
        claimed_peer.gid != observed_peer.gid ||
        claimed_peer.pid != observed_peer.pid ||
        claimed_peer.start_time_ticks != observed_peer.start_time_ticks
    {
        return Err(HelperError::authentication("PEER_IDENTITY_DRIFT"));
    }
    if request.mount_namespace.inode != observed_peer.mount_namespace_inode ||
        request.mount_namespace.root_mount_id != observed_root.mount_id
    {
        return Err(HelperError::namespace("MOUNT_NAMESPACE_DRIFT"));
    }
    if request.root_identity.device_major != observed_root.device_major ||
        request.root_identity.device_minor != observed_root.device_minor ||
        request.root_identity.inode != observed_root.inode ||
        request.root_identity.mount_id != observed_root.mount_id
    {
        return Err(HelperError::namespace("ROOT_IDENTITY_DRIFT"));
    }
    if request.volume_identity.mount_id() != observed_root.mount_id ||
        request.volume_identity.backend() != request.snapshot.backend
    {
        return Err(HelperError::volume("VOLUME_BINDING_DRIFT"));
    }
    let expected_root_digest = root_handle_digest(
        &request.boot_id,
        &request.daemon_epoch,
        &request.peer,
        request.mount_namespace.inode,
        observed_root,
    )?;
    if request.root_identity.root_handle_digest != expected_root_digest {
        return Err(HelperError::authentication("ROOT_HANDLE_DIGEST_MISMATCH"));
    }
    validate_install_provenance(&request.provenance, &policy.install_public_key)?;
    if request.provenance != policy.expected_provenance {
        return Err(HelperError::authentication("PROVENANCE_INSTALLATION_DRIFT"));
    }
    Ok(())
}

pub fn sign_transcript<T: Serialize>(key: &[u8], value: &T) -> Result<String, HelperError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| HelperError::authentication("TRANSCRIPT_KEY_INVALID"))?;
    mac.update(&canonical_json(value)?);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn verify_transcript_mac<T: Serialize>(
    key: &[u8],
    value: &T,
    mac_hex: &str,
) -> Result<(), HelperError> {
    let provided = hex::decode(mac_hex)
        .map_err(|_| HelperError::authentication("TRANSCRIPT_MAC_INVALID"))?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| HelperError::authentication("TRANSCRIPT_KEY_INVALID"))?;
    mac.update(&canonical_json(value)?);
    mac.verify_slice(&provided)
        .map_err(|_| HelperError::authentication("TRANSCRIPT_MAC_INVALID"))
}

pub fn validate_install_provenance(
    provenance: &InstallProvenanceV2,
    public_key: &VerifyingKey,
) -> Result<(), HelperError> {
    if provenance.schema_version != INSTALL_PROVENANCE_SCHEMA_VERSION ||
        !is_sha256(&provenance.bridge_binary_sha256) ||
        !is_sha256(&provenance.daemon_binary_sha256) ||
        !is_sha256(&provenance.manifest_sha256) ||
        !is_stable_token(&provenance.signature_key_id) ||
        !is_stable_token(&provenance.signer_id)
    {
        return Err(HelperError::authentication("PROVENANCE_SHAPE_INVALID"));
    }
    let payload = ProvenancePayloadV2 {
        bridge_binary_sha256: provenance.bridge_binary_sha256.clone(),
        daemon_binary_sha256: provenance.daemon_binary_sha256.clone(),
        schema_version: provenance.schema_version,
        signature_key_id: provenance.signature_key_id.clone(),
        signer_id: provenance.signer_id.clone(),
    };
    let payload_bytes = canonical_json(&payload)?;
    if canonical_sha256(&payload)? != provenance.manifest_sha256 {
        return Err(HelperError::authentication("PROVENANCE_MANIFEST_DIGEST"));
    }
    let signature_bytes = hex::decode(&provenance.signature)
        .map_err(|_| HelperError::authentication("PROVENANCE_SIGNATURE_INVALID"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| HelperError::authentication("PROVENANCE_SIGNATURE_INVALID"))?;
    public_key
        .verify(&payload_bytes, &signature)
        .map_err(|_| HelperError::authentication("PROVENANCE_SIGNATURE_INVALID"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutableRoleV2 {
    Bridge,
    Daemon,
}

/// 先验证签名 manifest，再从已打开 executable 句柄计算摘要并绑定到明确角色。
pub fn validate_executable_provenance_bytes<R: Read>(
    provenance: &InstallProvenanceV2,
    public_key: &VerifyingKey,
    mut executable: R,
    role: ExecutableRoleV2,
) -> Result<(), HelperError> {
    validate_install_provenance(provenance, public_key)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes = executable.read(&mut buffer)
            .map_err(|_| HelperError::authentication("PROVENANCE_EXECUTABLE_UNREADABLE"))?;
        if bytes == 0 {
            break;
        }
        digest.update(&buffer[..bytes]);
    }
    let expected = match role {
        ExecutableRoleV2::Bridge => &provenance.bridge_binary_sha256,
        ExecutableRoleV2::Daemon => &provenance.daemon_binary_sha256,
    };
    if hex::encode(digest.finalize()) != *expected {
        return Err(HelperError::authentication(
            "PROVENANCE_EXECUTABLE_DIGEST_MISMATCH",
        ));
    }
    Ok(())
}

/// `/proc/self/exe` 由内核绑定到当前执行文件对象；打开后按该 FD 读取，避免可替换路径 TOCTOU。
#[cfg(target_os = "linux")]
pub fn validate_running_executable_provenance(
    provenance: &InstallProvenanceV2,
    public_key: &VerifyingKey,
    role: ExecutableRoleV2,
) -> Result<(), HelperError> {
    let executable = File::open("/proc/self/exe")
        .map_err(|_| HelperError::authentication("PROVENANCE_EXECUTABLE_UNREADABLE"))?;
    validate_executable_provenance_bytes(provenance, public_key, executable, role)
}

pub fn root_handle_digest(
    boot_id: &str,
    daemon_epoch: &str,
    peer: &PeerIdentityV1,
    namespace_inode: u64,
    root: &ObservedRootV1,
) -> Result<String, HelperError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RootHandleDigest<'a> {
        boot_id: &'a str,
        daemon_epoch: &'a str,
        device_major: u32,
        device_minor: u32,
        inode: u64,
        mount_id: u64,
        namespace_inode: u64,
        peer: &'a PeerIdentityV1,
    }
    canonical_sha256(&RootHandleDigest {
        boot_id,
        daemon_epoch,
        device_major: root.device_major,
        device_minor: root.device_minor,
        inode: root.inode,
        mount_id: root.mount_id,
        namespace_inode,
        peer,
    })
}

pub fn validate_bridge_request(request: &crate::protocol::BridgeCaptureRequestV1) -> Result<(), HelperError> {
    if request.protocol_version != PROTOCOL_VERSION || request.abi_version != ABI_VERSION {
        return Err(HelperError::protocol("BRIDGE_VERSION"));
    }
    validate_candidates(&request.candidates)?;
    if !is_sha256(&request.batch_digest) ||
        !is_sha256(&request.capability_digest) ||
        !is_sha256(&request.request_digest) ||
        !is_stable_token(&request.request_id) ||
        !is_stable_token(&request.nonce)
    {
        return Err(HelperError::protocol("BRIDGE_SHAPE"));
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ClientRequestBody<'a> {
        abi_version: u16,
        batch_digest: &'a str,
        candidates: &'a [BridgeCandidateV1],
        capability_digest: &'a str,
        nonce: &'a str,
        protocol_version: u16,
        request_id: &'a str,
    }
    let expected_batch = canonical_sha256(&request.candidates)?;
    let expected_request = canonical_sha256(&ClientRequestBody {
        abi_version: request.abi_version,
        batch_digest: &request.batch_digest,
        candidates: &request.candidates,
        capability_digest: &request.capability_digest,
        nonce: &request.nonce,
        protocol_version: request.protocol_version,
        request_id: &request.request_id,
    })?;
    if request.batch_digest != expected_batch || request.request_digest != expected_request {
        return Err(HelperError::authentication("BRIDGE_DIGEST_MISMATCH"));
    }
    Ok(())
}

fn validate_request_shape(request: &AuthenticatedRequestV1) -> Result<(), HelperError> {
    if request.protocol_version != PROTOCOL_VERSION || request.abi_version != ABI_VERSION {
        return Err(HelperError::protocol("REQUEST_VERSION"));
    }
    validate_candidates(&request.candidates)?;
    for digest in [
        &request.batch_digest,
        &request.capability_digest,
        &request.client_request_digest,
        &request.root_identity.root_handle_digest,
        &request.provenance.bridge_binary_sha256,
        &request.provenance.daemon_binary_sha256,
        &request.provenance.manifest_sha256,
    ] {
        if !is_sha256(digest) {
            return Err(HelperError::protocol("REQUEST_DIGEST_SHAPE"));
        }
    }
    for token in [
        &request.boot_id,
        &request.daemon_epoch,
        &request.nonce,
        &request.request_id,
        &request.snapshot.fence_id,
        &request.snapshot.view_id,
    ] {
        if !is_stable_token(token) {
            return Err(HelperError::protocol("REQUEST_TOKEN_SHAPE"));
        }
    }
    if request.batch_digest != canonical_sha256(&request.candidates)? {
        return Err(HelperError::authentication("BATCH_DIGEST_MISMATCH"));
    }
    Ok(())
}

fn validate_candidates(candidates: &[BridgeCandidateV1]) -> Result<(), HelperError> {
    if candidates.is_empty() || candidates.len() > MAX_CANDIDATES {
        return Err(HelperError::budget("CANDIDATE_COUNT"));
    }
    let mut bytes = 0usize;
    for (expected_index, candidate) in candidates.iter().enumerate() {
        if candidate.candidate_index as usize != expected_index {
            return Err(HelperError::protocol("CANDIDATE_INDEX"));
        }
        for value in [
            &candidate.asserted_relative_path,
            &candidate.logical_path,
            &candidate.trusted_relative_path,
        ] {
            let length = value.len();
            if length == 0 || length > MAX_PATH_BYTES {
                return Err(HelperError::budget("PATH_SIZE"));
            }
            bytes = bytes.checked_add(length).ok_or_else(|| HelperError::budget("BATCH_SIZE"))?;
            if bytes > MAX_BATCH_BYTES {
                return Err(HelperError::budget("BATCH_SIZE"));
            }
            if value.nfc().collect::<String>() != *value {
                return Err(HelperError::path("PATH_NOT_NFC"));
            }
        }
        validate_relative_path(&candidate.asserted_relative_path)?;
        validate_relative_path(&candidate.trusted_relative_path)?;
        validate_logical_path(&candidate.logical_path)?;
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), HelperError> {
    if value.starts_with('/') || value.contains('\\') || value.as_bytes().contains(&0) ||
        value.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(HelperError::path("PATH_NOT_BENEATH"));
    }
    Ok(())
}

fn validate_logical_path(value: &str) -> Result<(), HelperError> {
    validate_relative_path(value)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn is_stable_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestMacBody<'a> {
    pub request: &'a AuthenticatedRequestV1,
    pub request_digest: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMacBody<'a, T: Serialize> {
    pub response: &'a T,
    pub response_digest: &'a str,
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use ed25519_dalek::{Signer, SigningKey};
    use sha2::Digest;

    use super::*;
    use crate::protocol::{
        MountNamespaceV1, RootIdentityV1, SnapshotBackendKindV1, SnapshotBindingV1,
        VolumeIdentityV1,
    };

    fn fixture() -> (AuthenticatedRequestEnvelopeV1, SecurityPolicyV1, ObservedPeerV1, ObservedRootV1) {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let payload = ProvenancePayloadV2 {
            bridge_binary_sha256: "a".repeat(64),
            daemon_binary_sha256: "b".repeat(64),
            schema_version: INSTALL_PROVENANCE_SCHEMA_VERSION,
            signature_key_id: "release-key-1".into(),
            signer_id: "codegraph-release-1".into(),
        };
        let payload_bytes = canonical_json(&payload).expect("payload");
        let provenance = InstallProvenanceV2 {
            bridge_binary_sha256: payload.bridge_binary_sha256.clone(),
            daemon_binary_sha256: payload.daemon_binary_sha256.clone(),
            manifest_sha256: canonical_sha256(&payload).expect("digest"),
            schema_version: payload.schema_version,
            signature: hex::encode(signing.sign(&payload_bytes).to_bytes()),
            signature_key_id: payload.signature_key_id.clone(),
            signer_id: payload.signer_id.clone(),
        };
        let peer = PeerIdentityV1 { gid: 1000, pid: 42, start_time_ticks: 77, uid: 1000 };
        let observed_peer = ObservedPeerV1 {
            gid: 1000,
            mount_namespace_inode: 99,
            pid: 42,
            start_time_ticks: 77,
            uid: 1000,
        };
        let observed_root = ObservedRootV1 {
            device_major: 8,
            device_minor: 1,
            inode: 2,
            mount_id: 11,
        };
        let candidates = vec![BridgeCandidateV1 {
            asserted_relative_path: "src/a.ts".into(),
            candidate_index: 0,
            logical_path: "src/a.ts".into(),
            trusted_relative_path: "src/a.ts".into(),
        }];
        let mut request = AuthenticatedRequestV1 {
            abi_version: ABI_VERSION,
            batch_digest: canonical_sha256(&candidates).expect("batch"),
            boot_id: "boot-1".into(),
            candidates,
            capability_digest: "b".repeat(64),
            client_request_digest: "c".repeat(64),
            daemon_epoch: "epoch-1".into(),
            deadline_unix_ms: 20_000,
            issued_at_unix_ms: 10_000,
            mount_namespace: MountNamespaceV1 { inode: 99, root_mount_id: 11 },
            nonce: "nonce-1".into(),
            peer,
            protocol_version: PROTOCOL_VERSION,
            provenance,
            request_id: "request-1".into(),
            root_identity: RootIdentityV1 {
                device_major: 8,
                device_minor: 1,
                inode: 2,
                mount_id: 11,
                root_handle_digest: String::new(),
            },
            sequence: 1,
            snapshot: SnapshotBindingV1 {
                backend: SnapshotBackendKindV1::Btrfs,
                fence_id: "btrfs:fence:request-1".into(),
                view_id: "btrfs:view:request-1".into(),
            },
            volume_identity: VolumeIdentityV1::Btrfs {
                device: "/dev/sda1".into(),
                filesystem_uuid: "11111111-1111-1111-1111-111111111111".into(),
                mount_id: 11,
                subvolume_id: 5,
            },
        };
        request.root_identity.root_handle_digest = root_handle_digest(
            &request.boot_id,
            &request.daemon_epoch,
            &request.peer,
            request.mount_namespace.inode,
            &observed_root,
        ).expect("root digest");
        let request_digest = canonical_sha256(&request).expect("request digest");
        let transcript_key = vec![9; 32];
        let transcript_mac = sign_transcript(
            &transcript_key,
            &RequestMacBody { request: &request, request_digest: &request_digest },
        ).expect("mac");
        let expected_provenance = request.provenance.clone();
        (
            AuthenticatedRequestEnvelopeV1 { request, request_digest, transcript_mac },
            SecurityPolicyV1 {
                boot_id: "boot-1".into(),
                daemon_epoch: "epoch-1".into(),
                expected_provenance,
                install_public_key: signing.verifying_key(),
                max_clock_skew_ms: 100,
                transcript_key,
            },
            observed_peer,
            observed_root,
        )
    }

    #[test]
    fn auth_replay_deadline_and_drift_fail_closed() {
        let (request, policy, peer, root) = fixture();
        validate_authenticated_request(&request, &policy, &peer, &root, 11_000).expect("valid");

        let mut tampered = request.clone();
        tampered.request.nonce = "nonce-2".into();
        assert_eq!(
            validate_authenticated_request(&tampered, &policy, &peer, &root, 11_000)
                .expect_err("tamper").code,
            "REQUEST_DIGEST_MISMATCH"
        );
        assert_eq!(
            validate_authenticated_request(&request, &policy, &peer, &root, 21_000)
                .expect_err("expired").code,
            "REQUEST_EXPIRED"
        );
        let mut drifted_peer = peer.clone();
        drifted_peer.start_time_ticks += 1;
        assert_eq!(
            validate_authenticated_request(&request, &policy, &drifted_peer, &root, 11_000)
                .expect_err("peer drift").code,
            "PEER_IDENTITY_DRIFT"
        );

        let mut replay = ReplayCache::new(8).expect("cache");
        replay.consume(&request, 11_000).expect("first");
        assert_eq!(replay.consume(&request, 11_000).expect_err("replay").code, "REPLAY_DUPLICATE");

        let mut new_bridge = request.clone();
        new_bridge.request.peer.pid += 1;
        new_bridge.request.peer.start_time_ticks += 1;
        assert_eq!(
            replay.consume(&new_bridge, 11_000).expect_err("cross-process replay").code,
            "REPLAY_DUPLICATE",
        );
        new_bridge.request.nonce = "nonce-2".into();
        new_bridge.request_digest = "d".repeat(64);
        assert_eq!(
            replay.consume(&new_bridge, 11_000).expect_err("monotonic sequence").code,
            "SEQUENCE_NOT_MONOTONIC",
        );
    }

    #[test]
    fn signed_provenance_must_match_each_running_executable_role() {
        let signing = SigningKey::from_bytes(&[5; 32]);
        let executable = b"trusted-daemon-executable";
        let payload = ProvenancePayloadV2 {
            bridge_binary_sha256: hex::encode(Sha256::digest(b"trusted-bridge-executable")),
            daemon_binary_sha256: hex::encode(Sha256::digest(executable)),
            schema_version: INSTALL_PROVENANCE_SCHEMA_VERSION,
            signature_key_id: "release-key-1".into(),
            signer_id: "codegraph-release-1".into(),
        };
        let provenance = InstallProvenanceV2 {
            bridge_binary_sha256: payload.bridge_binary_sha256.clone(),
            daemon_binary_sha256: payload.daemon_binary_sha256.clone(),
            manifest_sha256: canonical_sha256(&payload).expect("digest"),
            schema_version: payload.schema_version,
            signature: hex::encode(
                signing.sign(&canonical_json(&payload).expect("payload")).to_bytes(),
            ),
            signature_key_id: payload.signature_key_id.clone(),
            signer_id: payload.signer_id.clone(),
        };

        validate_executable_provenance_bytes(
            &provenance,
            &signing.verifying_key(),
            Cursor::new(executable),
            ExecutableRoleV2::Daemon,
        ).expect("matching executable");
        validate_executable_provenance_bytes(
            &provenance,
            &signing.verifying_key(),
            Cursor::new(b"trusted-bridge-executable"),
            ExecutableRoleV2::Bridge,
        ).expect("matching bridge executable");
        assert_eq!(
            validate_executable_provenance_bytes(
                &provenance,
                &signing.verifying_key(),
                Cursor::new(b"replaced-daemon-executable"),
                ExecutableRoleV2::Daemon,
            ).expect_err("replacement must be rejected").code,
            "PROVENANCE_EXECUTABLE_DIGEST_MISMATCH",
        );
        assert_eq!(
            validate_executable_provenance_bytes(
                &provenance,
                &signing.verifying_key(),
                Cursor::new(executable),
                ExecutableRoleV2::Bridge,
            ).expect_err("daemon digest must not satisfy the bridge role").code,
            "PROVENANCE_EXECUTABLE_DIGEST_MISMATCH",
        );
    }
}
