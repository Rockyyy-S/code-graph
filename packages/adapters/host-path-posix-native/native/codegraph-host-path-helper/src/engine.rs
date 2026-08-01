use crate::{
    canonical::canonical_sha256,
    protocol::{
        ABI_VERSION, AuthenticatedRequestEnvelopeV1, AuthenticatedRequestV1,
        AuthenticatedResponseEnvelopeV1, CaptureItemV1, ErrorResponseV1, HelperError,
        HelperResponseV1, PROTOCOL_VERSION, ResponseStatusV1,
    },
    security::{
        ObservedPeerV1, ObservedRootV1, ReplayCache, ResponseMacBody, SecurityPolicyV1,
        sign_transcript, validate_authenticated_request,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendCaptureV1 {
    pub items: Vec<CaptureItemV1>,
    pub root_object_id: String,
    pub snapshot_fence: String,
    pub snapshot_view: String,
    pub volume_id: String,
}

pub trait SnapshotBackend {
    fn capture(
        &mut self,
        request: &AuthenticatedRequestV1,
        root_fd: i32,
    ) -> Result<BackendCaptureV1, HelperError>;
}

pub struct CaptureEngine<B> {
    backend: B,
    policy: SecurityPolicyV1,
    replay: ReplayCache,
}

impl<B: SnapshotBackend> CaptureEngine<B> {
    pub fn new(backend: B, policy: SecurityPolicyV1, replay_capacity: usize) -> Result<Self, HelperError> {
        Ok(Self { backend, policy, replay: ReplayCache::new(replay_capacity)? })
    }

    pub fn handle(
        &mut self,
        envelope: &AuthenticatedRequestEnvelopeV1,
        observed_peer: &ObservedPeerV1,
        observed_root: &ObservedRootV1,
        root_fd: i32,
        now_unix_ms: u64,
    ) -> Result<AuthenticatedResponseEnvelopeV1, HelperError> {
        validate_authenticated_request(
            envelope,
            &self.policy,
            observed_peer,
            observed_root,
            now_unix_ms,
        )?;
        self.replay.consume(envelope, now_unix_ms)?;
        let backend = self.backend.capture(&envelope.request, root_fd);
        let response = match backend {
            Ok(capture) => HelperResponseV1 {
                abi_version: ABI_VERSION,
                batch_digest: envelope.request.batch_digest.clone(),
                capability_digest: envelope.request.capability_digest.clone(),
                daemon_epoch: envelope.request.daemon_epoch.clone(),
                error: None,
                items: capture.items,
                nonce: envelope.request.nonce.clone(),
                protocol_version: PROTOCOL_VERSION,
                provenance: envelope.request.provenance.clone(),
                request_digest: envelope.request_digest.clone(),
                request_id: envelope.request.request_id.clone(),
                root_object_id: Some(capture.root_object_id),
                sequence: envelope.request.sequence,
                snapshot_fence: capture.snapshot_fence,
                snapshot_view: capture.snapshot_view,
                status: ResponseStatusV1::Complete,
                volume_id: Some(capture.volume_id),
            },
            Err(error) => HelperResponseV1 {
                abi_version: ABI_VERSION,
                batch_digest: envelope.request.batch_digest.clone(),
                capability_digest: envelope.request.capability_digest.clone(),
                daemon_epoch: envelope.request.daemon_epoch.clone(),
                error: Some(ErrorResponseV1::from(&error)),
                items: Vec::new(),
                nonce: envelope.request.nonce.clone(),
                protocol_version: PROTOCOL_VERSION,
                provenance: envelope.request.provenance.clone(),
                request_digest: envelope.request_digest.clone(),
                request_id: envelope.request.request_id.clone(),
                root_object_id: None,
                sequence: envelope.request.sequence,
                snapshot_fence: envelope.request.snapshot.fence_id.clone(),
                snapshot_view: envelope.request.snapshot.view_id.clone(),
                status: ResponseStatusV1::Failed,
                volume_id: None,
            },
        };
        let response_digest = canonical_sha256(&response)?;
        let transcript_mac = sign_transcript(
            &self.policy.transcript_key,
            &ResponseMacBody { response: &response, response_digest: &response_digest },
        )?;
        Ok(AuthenticatedResponseEnvelopeV1 { response, response_digest, transcript_mac })
    }

    pub fn into_backend(self) -> B {
        self.backend
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;
    use crate::{
        canonical::{canonical_json, canonical_sha256},
        protocol::{
            BridgeCandidateV1, InstallProvenanceV1, MountNamespaceV1, PeerIdentityV1,
            ProvenancePayloadV1, RootIdentityV1, SnapshotBackendKindV1, SnapshotBindingV1,
            VolumeIdentityV1,
        },
        security::{RequestMacBody, root_handle_digest},
    };

    struct FakeBackend {
        calls: usize,
        fail: bool,
    }

    impl SnapshotBackend for FakeBackend {
        fn capture(
            &mut self,
            request: &AuthenticatedRequestV1,
            _root_fd: i32,
        ) -> Result<BackendCaptureV1, HelperError> {
            self.calls += 1;
            if self.fail {
                return Err(HelperError::snapshot("FAKE_SNAPSHOT_FAILED", false));
            }
            Ok(BackendCaptureV1 {
                items: request.candidates.iter().map(|candidate| CaptureItemV1 {
                    candidate_index: candidate.candidate_index,
                    object_id: format!("8:1:11:{}", candidate.candidate_index + 100),
                }).collect(),
                root_object_id: "8:1:11:2".into(),
                snapshot_fence: request.snapshot.fence_id.clone(),
                snapshot_view: request.snapshot.view_id.clone(),
                volume_id: "btrfs:8:1".into(),
            })
        }
    }

    fn fixture() -> (
        AuthenticatedRequestEnvelopeV1,
        SecurityPolicyV1,
        ObservedPeerV1,
        ObservedRootV1,
    ) {
        let signing = SigningKey::from_bytes(&[3; 32]);
        let payload = ProvenancePayloadV1 {
            binary_sha256: "a".repeat(64),
            signature_key_id: "key-1".into(),
            signer_id: "signer-1".into(),
        };
        let provenance = InstallProvenanceV1 {
            binary_sha256: payload.binary_sha256.clone(),
            manifest_sha256: canonical_sha256(&payload).expect("manifest"),
            signature: hex::encode(signing.sign(&canonical_json(&payload).expect("payload")).to_bytes()),
            signature_key_id: payload.signature_key_id.clone(),
            signer_id: payload.signer_id.clone(),
        };
        let peer = PeerIdentityV1 { gid: 1000, pid: 10, start_time_ticks: 20, uid: 1000 };
        let observed_peer = ObservedPeerV1 {
            gid: 1000,
            mount_namespace_inode: 30,
            pid: 10,
            start_time_ticks: 20,
            uid: 1000,
        };
        let root = ObservedRootV1 { device_major: 8, device_minor: 1, inode: 2, mount_id: 11 };
        let candidates = vec![
            BridgeCandidateV1 {
                asserted_relative_path: "a.ts".into(),
                candidate_index: 0,
                logical_path: "a.ts".into(),
                trusted_relative_path: "a.ts".into(),
            },
            BridgeCandidateV1 {
                asserted_relative_path: "b.ts".into(),
                candidate_index: 1,
                logical_path: "b.ts".into(),
                trusted_relative_path: "b.ts".into(),
            },
        ];
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
            mount_namespace: MountNamespaceV1 { inode: 30, root_mount_id: 11 },
            nonce: "nonce-1".into(),
            peer: peer.clone(),
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
            &peer,
            30,
            &root,
        ).expect("root digest");
        let request_digest = canonical_sha256(&request).expect("request");
        let transcript_key = vec![4; 32];
        let transcript_mac = crate::security::sign_transcript(
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
            root,
        )
    }

    #[test]
    fn fixed_batch_enters_backend_once_and_failures_are_signed() {
        let (request, policy, peer, root) = fixture();
        let mut engine = CaptureEngine::new(FakeBackend { calls: 0, fail: false }, policy.clone(), 8)
            .expect("engine");
        let response = engine.handle(&request, &peer, &root, 3, 11_000).expect("response");
        assert_eq!(response.response.status, ResponseStatusV1::Complete);
        assert_eq!(response.response.items.len(), 2);
        assert_eq!(engine.into_backend().calls, 1);

        let (mut retry, _, _, _) = fixture();
        retry.request.sequence = 2;
        retry.request.nonce = "nonce-2".into();
        retry.request_digest = canonical_sha256(&retry.request).expect("digest");
        retry.transcript_mac = crate::security::sign_transcript(
            &policy.transcript_key,
            &RequestMacBody { request: &retry.request, request_digest: &retry.request_digest },
        ).expect("mac");
        let mut failing = CaptureEngine::new(FakeBackend { calls: 0, fail: true }, policy, 8)
            .expect("engine");
        let response = failing.handle(&retry, &peer, &root, 3, 11_000).expect("signed failure");
        assert_eq!(response.response.status, ResponseStatusV1::Failed);
        assert_eq!(response.response.error.expect("error").code, "FAKE_SNAPSHOT_FAILED");
    }
}
