use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL_VERSION: u16 = 1;
pub const ABI_VERSION: u16 = 2;
pub const INSTALL_PROVENANCE_SCHEMA_VERSION: u16 = 2;
pub const MAX_CANDIDATES: usize = 6_144;
pub const MAX_PATH_BYTES: usize = 128 * 1024;
pub const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DEADLINE_WINDOW_MS: u64 = 60_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeCaptureRequestV1 {
    pub abi_version: u16,
    pub batch_digest: String,
    pub candidates: Vec<BridgeCandidateV1>,
    pub capability_digest: String,
    pub nonce: String,
    pub protocol_version: u16,
    pub request_digest: String,
    pub request_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeCandidateV1 {
    pub asserted_relative_path: String,
    pub candidate_index: u32,
    pub logical_path: String,
    pub trusted_relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatedRequestEnvelopeV1 {
    pub request: AuthenticatedRequestV1,
    pub request_digest: String,
    pub transcript_mac: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatedRequestV1 {
    pub abi_version: u16,
    pub batch_digest: String,
    pub boot_id: String,
    pub candidates: Vec<BridgeCandidateV1>,
    pub capability_digest: String,
    pub client_request_digest: String,
    pub daemon_epoch: String,
    pub deadline_unix_ms: u64,
    pub issued_at_unix_ms: u64,
    pub mount_namespace: MountNamespaceV1,
    pub nonce: String,
    pub peer: PeerIdentityV1,
    pub protocol_version: u16,
    pub provenance: InstallProvenanceV2,
    pub request_id: String,
    pub root_identity: RootIdentityV1,
    pub sequence: u64,
    pub snapshot: SnapshotBindingV1,
    pub volume_identity: VolumeIdentityV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerIdentityV1 {
    pub gid: u32,
    pub pid: u32,
    pub start_time_ticks: u64,
    pub uid: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MountNamespaceV1 {
    pub inode: u64,
    pub root_mount_id: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootIdentityV1 {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: u64,
    pub mount_id: u64,
    pub root_handle_digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotBindingV1 {
    pub backend: SnapshotBackendKindV1,
    pub fence_id: String,
    pub view_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotBackendKindV1 {
    Btrfs,
    Lvm,
    Zfs,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LvmFilesystemV1 {
    Ext4,
    Xfs,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum VolumeIdentityV1 {
    Btrfs {
        device: String,
        filesystem_uuid: String,
        mount_id: u64,
        subvolume_id: u64,
    },
    Lvm {
        device: String,
        device_major_minor: String,
        filesystem: LvmFilesystemV1,
        mount_id: u64,
        origin_lv: String,
        origin_lv_uuid: String,
        vg_name: String,
        vg_uuid: String,
    },
    Zfs {
        dataset: String,
        dataset_guid: String,
        mount_id: u64,
        pool: String,
    },
}

impl VolumeIdentityV1 {
    pub fn mount_id(&self) -> u64 {
        match self {
            Self::Btrfs { mount_id, .. }
            | Self::Lvm { mount_id, .. }
            | Self::Zfs { mount_id, .. } => *mount_id,
        }
    }

    pub fn backend(&self) -> SnapshotBackendKindV1 {
        match self {
            Self::Btrfs { .. } => SnapshotBackendKindV1::Btrfs,
            Self::Lvm { .. } => SnapshotBackendKindV1::Lvm,
            Self::Zfs { .. } => SnapshotBackendKindV1::Zfs,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallProvenanceV2 {
    pub bridge_binary_sha256: String,
    pub daemon_binary_sha256: String,
    pub manifest_sha256: String,
    pub schema_version: u16,
    pub signature: String,
    pub signature_key_id: String,
    pub signer_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvenancePayloadV2 {
    pub bridge_binary_sha256: String,
    pub daemon_binary_sha256: String,
    pub schema_version: u16,
    pub signature_key_id: String,
    pub signer_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatedResponseEnvelopeV1 {
    pub response: HelperResponseV1,
    pub response_digest: String,
    pub transcript_mac: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperResponseV1 {
    pub abi_version: u16,
    pub batch_digest: String,
    pub capability_digest: String,
    pub daemon_epoch: String,
    pub error: Option<ErrorResponseV1>,
    pub items: Vec<CaptureItemV1>,
    pub nonce: String,
    pub protocol_version: u16,
    pub provenance: InstallProvenanceV2,
    pub request_digest: String,
    pub request_id: String,
    pub root_object_id: Option<String>,
    pub sequence: u64,
    pub snapshot_fence: String,
    pub snapshot_view: String,
    pub status: ResponseStatusV1,
    pub volume_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseStatusV1 {
    Complete,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureItemV1 {
    pub candidate_index: u32,
    pub object_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorResponseV1 {
    pub class: HelperErrorClass,
    pub code: String,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HelperErrorClass {
    Authentication,
    Budget,
    Cleanup,
    Deadline,
    NamespaceDrift,
    PathBoundary,
    Protocol,
    Replay,
    Snapshot,
    Unsupported,
    VolumeDrift,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{code}")]
pub struct HelperError {
    pub class: HelperErrorClass,
    pub code: String,
    pub retryable: bool,
}

impl HelperError {
    pub fn new(class: HelperErrorClass, code: impl Into<String>, retryable: bool) -> Self {
        Self { class, code: code.into(), retryable }
    }

    pub fn authentication(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Authentication, code, false)
    }

    pub fn budget(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Budget, code, false)
    }

    pub fn cleanup(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Cleanup, code, false)
    }

    pub fn deadline(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Deadline, code, true)
    }

    pub fn namespace(code: &'static str) -> Self {
        Self::new(HelperErrorClass::NamespaceDrift, code, true)
    }

    pub fn path(code: &'static str) -> Self {
        Self::new(HelperErrorClass::PathBoundary, code, false)
    }

    pub fn protocol(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Protocol, code, false)
    }

    pub fn replay(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Replay, code, false)
    }

    pub fn snapshot(code: &'static str, retryable: bool) -> Self {
        Self::new(HelperErrorClass::Snapshot, code, retryable)
    }

    pub fn unsupported(code: &'static str) -> Self {
        Self::new(HelperErrorClass::Unsupported, code, false)
    }

    pub fn volume(code: &'static str) -> Self {
        Self::new(HelperErrorClass::VolumeDrift, code, true)
    }
}

impl From<&HelperError> for ErrorResponseV1 {
    fn from(value: &HelperError) -> Self {
        Self { class: value.class, code: value.code.clone(), retryable: value.retryable }
    }
}
