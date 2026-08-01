#[cfg(target_os = "linux")]
mod linux {
    use std::{
        env,
        fs,
        io,
        os::fd::{AsRawFd, BorrowedFd},
        os::unix::net::UnixStream,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use codegraph_host_path_helper::{
        canonical::{canonical_json, canonical_sha256, decode_frame, encode_frame},
        command::{CommandExecutor, CommandSpec, SystemCommandExecutor},
        path_boundary::stat_identity_fd,
        protocol::{
            ABI_VERSION, AuthenticatedRequestEnvelopeV1, AuthenticatedRequestV1,
            AuthenticatedResponseEnvelopeV1, BridgeCaptureRequestV1, CaptureItemV1,
            ErrorResponseV1, HelperError, InstallProvenanceV2, MountNamespaceV1,
            LvmFilesystemV1, PeerIdentityV1, PROTOCOL_VERSION, ResponseStatusV1, RootIdentityV1,
            SnapshotBackendKindV1, SnapshotBindingV1, VolumeIdentityV1,
        },
        security::{
            ExecutableRoleV2, RequestMacBody, ResponseMacBody, is_stable_token,
            root_handle_digest, sign_transcript, validate_bridge_request,
            validate_running_executable_provenance, verify_transcript_mac,
        },
        transport::{read_frame, self_peer, send_frame_with_fd, write_frame},
    };
    use ed25519_dalek::VerifyingKey;
    use serde::Serialize;

    const ROOT_FD: i32 = 3;
    const SOCKET_PATH: &str = "/run/codegraph-host-path/helper.sock";
    const KEY_PATH: &str = "/etc/codegraph-host-path/client.key";
    const PROVENANCE_PATH: &str = "/usr/share/codegraph-host-path/provenance.json";
    const PUBLIC_KEY_PATH: &str = "/usr/share/codegraph-host-path/release.pub";

    #[derive(Debug)]
    struct Args {
        deadline_ms: u64,
        key_path: PathBuf,
        provenance_path: PathBuf,
        public_key_path: PathBuf,
        socket_path: PathBuf,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeOutputProvenanceV2<'a> {
        bridge_binary_sha256: &'a str,
        daemon_binary_sha256: &'a str,
        manifest_sha256: &'a str,
        schema_version: u16,
        signature_key_id: &'a str,
        signer_id: &'a str,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeCompleteOutputV1<'a> {
        abi_version: u16,
        batch_digest: &'a str,
        capability_digest: &'a str,
        daemon_epoch: &'a str,
        items: &'a [CaptureItemV1],
        nonce: &'a str,
        protocol_version: u16,
        provenance: BridgeOutputProvenanceV2<'a>,
        request_digest: &'a str,
        request_id: &'a str,
        root_object_id: &'a str,
        sequence: u64,
        snapshot_fence: &'a str,
        snapshot_view: &'a str,
        status: &'static str,
        transcript_mac: &'a str,
        volume_id: &'a str,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeFailedOutputV1<'a> {
        abi_version: u16,
        batch_digest: &'a str,
        capability_digest: &'a str,
        daemon_epoch: &'a str,
        error: &'a ErrorResponseV1,
        items: &'a [CaptureItemV1],
        nonce: &'a str,
        protocol_version: u16,
        provenance: BridgeOutputProvenanceV2<'a>,
        request_digest: &'a str,
        request_id: &'a str,
        root_object_id: Option<&'a str>,
        sequence: u64,
        snapshot_fence: &'a str,
        snapshot_view: &'a str,
        status: &'static str,
        transcript_mac: &'a str,
        volume_id: Option<&'a str>,
    }

    pub fn main() -> Result<(), HelperError> {
        let args = parse_args(env::args().skip(1).collect())?;
        let frame = read_frame(&mut io::stdin().lock())?;
        let client: BridgeCaptureRequestV1 = decode_frame(&frame)?;
        validate_bridge_request(&client)?;
        let public_key = VerifyingKey::from_bytes(
            &read_hex(&args.public_key_path, 32)?
                .try_into()
                .map_err(|_| HelperError::authentication("PUBLIC_KEY_INVALID"))?,
        ).map_err(|_| HelperError::authentication("PUBLIC_KEY_INVALID"))?;
        let provenance: InstallProvenanceV2 = read_canonical_json(&args.provenance_path)?;
        validate_running_executable_provenance(
            &provenance,
            &public_key,
            ExecutableRoleV2::Bridge,
        )?;
        let key = read_hex(&args.key_path, 32)?;
        let boot_id = read_token(Path::new("/proc/sys/kernel/random/boot_id"))?;
        let epoch_path = args.socket_path.parent()
            .ok_or_else(|| HelperError::protocol("SOCKET_PARENT"))?
            .join("daemon.epoch");
        let daemon_epoch = read_token(&epoch_path)?;
        let peer = self_peer()?;
        reject_rootless_user_namespace()?;
        // SAFETY: Node 只通过 stdio[3] 继承真实目录 FD；bridge 不接受任何替代 token。
        let root_fd = unsafe { BorrowedFd::borrow_raw(ROOT_FD) };
        let root = stat_identity_fd(root_fd.as_raw_fd())?;
        let volume_identity = discover_volume_identity(&root)?;
        let backend = volume_identity.backend();
        let issued_at_unix_ms = now_unix_ms()?;
        let deadline_unix_ms = issued_at_unix_ms
            .checked_add(args.deadline_ms)
            .ok_or_else(|| HelperError::deadline("DEADLINE_OVERFLOW"))?;
        let sequence = boot_time_nanoseconds()?;
        let peer_claim = PeerIdentityV1 {
            gid: peer.gid,
            pid: peer.pid,
            start_time_ticks: peer.start_time_ticks,
            uid: peer.uid,
        };
        let root_observed = codegraph_host_path_helper::security::ObservedRootV1 {
            device_major: root.device_major,
            device_minor: root.device_minor,
            inode: root.inode,
            mount_id: root.mount_id,
        };
        let root_handle_digest = root_handle_digest(
            &boot_id,
            &daemon_epoch,
            &peer_claim,
            peer.mount_namespace_inode,
            &root_observed,
        )?;
        let request_suffix = &canonical_sha256(&client)?[..20];
        let backend_name = backend_name(backend);
        let request = AuthenticatedRequestV1 {
            abi_version: ABI_VERSION,
            batch_digest: client.batch_digest.clone(),
            boot_id,
            candidates: client.candidates,
            capability_digest: client.capability_digest,
            client_request_digest: client.request_digest,
            daemon_epoch,
            deadline_unix_ms,
            issued_at_unix_ms,
            mount_namespace: MountNamespaceV1 {
                inode: peer.mount_namespace_inode,
                root_mount_id: root.mount_id,
            },
            nonce: client.nonce,
            peer: peer_claim,
            protocol_version: PROTOCOL_VERSION,
            provenance,
            request_id: client.request_id,
            root_identity: RootIdentityV1 {
                device_major: root.device_major,
                device_minor: root.device_minor,
                inode: root.inode,
                mount_id: root.mount_id,
                root_handle_digest,
            },
            sequence,
            snapshot: SnapshotBindingV1 {
                backend,
                fence_id: format!("{backend_name}:readonly-fence:{request_suffix}"),
                view_id: format!("{backend_name}:snapshot-view:{request_suffix}"),
            },
            volume_identity,
        };
        let request_digest = canonical_sha256(&request)?;
        let transcript_mac = sign_transcript(
            &key,
            &RequestMacBody { request: &request, request_digest: &request_digest },
        )?;
        let envelope = AuthenticatedRequestEnvelopeV1 { request, request_digest, transcript_mac };
        let mut socket = UnixStream::connect(&args.socket_path)
            .map_err(|_| HelperError::authentication("HELPER_UNAVAILABLE"))?;
        send_frame_with_fd(&mut socket, &encode_frame(&envelope)?, root_fd.as_raw_fd())?;
        let response_frame = read_frame(&mut socket)?;
        let response: AuthenticatedResponseEnvelopeV1 = decode_frame(&response_frame)?;
        validate_response(&response, &envelope, &key)?;
        let output = match response.response.status {
            ResponseStatusV1::Complete => {
                let root_object_id = response.response.root_object_id.as_deref()
                    .ok_or_else(|| HelperError::protocol("COMPLETE_ROOT_MISSING"))?;
                let volume_id = response.response.volume_id.as_deref()
                    .ok_or_else(|| HelperError::protocol("COMPLETE_VOLUME_MISSING"))?;
                encode_frame(&BridgeCompleteOutputV1 {
                    abi_version: response.response.abi_version,
                    batch_digest: &response.response.batch_digest,
                    capability_digest: &response.response.capability_digest,
                    daemon_epoch: &response.response.daemon_epoch,
                    items: &response.response.items,
                    nonce: &response.response.nonce,
                    protocol_version: response.response.protocol_version,
                    provenance: BridgeOutputProvenanceV2 {
                        bridge_binary_sha256: &response.response.provenance.bridge_binary_sha256,
                        daemon_binary_sha256: &response.response.provenance.daemon_binary_sha256,
                        manifest_sha256: &response.response.provenance.manifest_sha256,
                        schema_version: response.response.provenance.schema_version,
                        signature_key_id: &response.response.provenance.signature_key_id,
                        signer_id: &response.response.provenance.signer_id,
                    },
                    request_digest: &response.response.request_digest,
                    request_id: &response.response.request_id,
                    root_object_id,
                    sequence: response.response.sequence,
                    snapshot_fence: &response.response.snapshot_fence,
                    snapshot_view: &response.response.snapshot_view,
                    status: "complete",
                    transcript_mac: &response.transcript_mac,
                    volume_id,
                })?
            }
            ResponseStatusV1::Failed => {
                let error = response.response.error.as_ref()
                    .ok_or_else(|| HelperError::protocol("FAILED_ERROR_MISSING"))?;
                encode_frame(&BridgeFailedOutputV1 {
                    abi_version: response.response.abi_version,
                    batch_digest: &response.response.batch_digest,
                    capability_digest: &response.response.capability_digest,
                    daemon_epoch: &response.response.daemon_epoch,
                    error,
                    items: &response.response.items,
                    nonce: &response.response.nonce,
                    protocol_version: response.response.protocol_version,
                    provenance: BridgeOutputProvenanceV2 {
                        bridge_binary_sha256: &response.response.provenance.bridge_binary_sha256,
                        daemon_binary_sha256: &response.response.provenance.daemon_binary_sha256,
                        manifest_sha256: &response.response.provenance.manifest_sha256,
                        schema_version: response.response.provenance.schema_version,
                        signature_key_id: &response.response.provenance.signature_key_id,
                        signer_id: &response.response.provenance.signer_id,
                    },
                    request_digest: &response.response.request_digest,
                    request_id: &response.response.request_id,
                    root_object_id: response.response.root_object_id.as_deref(),
                    sequence: response.response.sequence,
                    snapshot_fence: &response.response.snapshot_fence,
                    snapshot_view: &response.response.snapshot_view,
                    status: "failed",
                    transcript_mac: &response.transcript_mac,
                    volume_id: response.response.volume_id.as_deref(),
                })?
            }
        };
        write_frame(&mut io::stdout().lock(), &output)
    }

    fn validate_response(
        response: &AuthenticatedResponseEnvelopeV1,
        request: &AuthenticatedRequestEnvelopeV1,
        key: &[u8],
    ) -> Result<(), HelperError> {
        if response.response_digest != canonical_sha256(&response.response)? {
            return Err(HelperError::authentication("RESPONSE_DIGEST_MISMATCH"));
        }
        verify_transcript_mac(
            key,
            &ResponseMacBody {
                response: &response.response,
                response_digest: &response.response_digest,
            },
            &response.transcript_mac,
        )?;
        let value = &response.response;
        if value.protocol_version != PROTOCOL_VERSION ||
            value.abi_version != ABI_VERSION ||
            value.batch_digest != request.request.batch_digest ||
            value.capability_digest != request.request.capability_digest ||
            value.daemon_epoch != request.request.daemon_epoch ||
            value.nonce != request.request.nonce ||
            value.request_digest != request.request_digest ||
            value.request_id != request.request.request_id ||
            value.sequence != request.request.sequence ||
            value.snapshot_fence != request.request.snapshot.fence_id ||
            value.snapshot_view != request.request.snapshot.view_id ||
            value.provenance != request.request.provenance
        {
            return Err(HelperError::authentication("RESPONSE_BINDING_MISMATCH"));
        }
        match value.status {
            ResponseStatusV1::Complete if value.error.is_none() &&
                value.items.len() == request.request.candidates.len() => Ok(()),
            ResponseStatusV1::Failed if value.error.is_some() && value.items.is_empty() => Ok(()),
            _ => Err(HelperError::protocol("RESPONSE_STATUS_SHAPE")),
        }
    }

    fn parse_args(values: Vec<String>) -> Result<Args, HelperError> {
        if values.len() != 11 || values[0] != "capture-v1" || values[1] != "--socket" ||
            values[3] != "--key" || values[5] != "--provenance" ||
            values[7] != "--public-key" || values[9] != "--deadline-ms"
        {
            return Err(HelperError::protocol("BRIDGE_ARGV"));
        }
        if values[2] != SOCKET_PATH || values[4] != KEY_PATH || values[6] != PROVENANCE_PATH ||
            values[8] != PUBLIC_KEY_PATH
        {
            return Err(HelperError::protocol("BRIDGE_INSTALL_LAYOUT"));
        }
        let socket_path = canonical_absolute_path(&values[2])?;
        let key_path = canonical_absolute_path(&values[4])?;
        let provenance_path = canonical_absolute_path(&values[6])?;
        let public_key_path = canonical_absolute_path(&values[8])?;
        let deadline_ms = values[10].parse::<u64>()
            .ok()
            .filter(|value| (1..=60_000).contains(value))
            .ok_or_else(|| HelperError::deadline("BRIDGE_DEADLINE"))?;
        Ok(Args { deadline_ms, key_path, provenance_path, public_key_path, socket_path })
    }

    fn canonical_absolute_path(value: &str) -> Result<PathBuf, HelperError> {
        let path = Path::new(value);
        if !path.is_absolute() || value.contains('\\') || value.as_bytes().contains(&0) ||
            path.components().any(|component| matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            ))
        {
            return Err(HelperError::protocol("CONFIG_PATH"));
        }
        Ok(path.to_owned())
    }

    fn read_hex(path: &Path, expected_bytes: usize) -> Result<Vec<u8>, HelperError> {
        let source = fs::read_to_string(path).map_err(|_| HelperError::authentication("KEY_UNREADABLE"))?;
        let value = source.trim_end_matches(['\r', '\n']);
        if value.len() != expected_bytes * 2 ||
            !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(HelperError::authentication("KEY_INVALID"));
        }
        hex::decode(value).map_err(|_| HelperError::authentication("KEY_INVALID"))
    }

    fn read_canonical_json<T: serde::de::DeserializeOwned + Serialize>(path: &Path) -> Result<T, HelperError> {
        let bytes = fs::read(path).map_err(|_| HelperError::authentication("PROVENANCE_UNREADABLE"))?;
        let payload = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
        let value: T = serde_json::from_slice(payload)
            .map_err(|_| HelperError::authentication("PROVENANCE_JSON"))?;
        if canonical_json(&value)? != payload {
            return Err(HelperError::authentication("PROVENANCE_NOT_CANONICAL"));
        }
        Ok(value)
    }

    fn read_token(path: &Path) -> Result<String, HelperError> {
        let value = fs::read_to_string(path)
            .map_err(|_| HelperError::authentication("TOKEN_UNREADABLE"))?
            .trim()
            .to_owned();
        if !is_stable_token(&value) {
            return Err(HelperError::authentication("TOKEN_INVALID"));
        }
        Ok(value)
    }

    fn now_unix_ms() -> Result<u64, HelperError> {
        u64::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)
                .map_err(|_| HelperError::deadline("CLOCK_INVALID"))?
                .as_millis(),
        ).map_err(|_| HelperError::deadline("CLOCK_OVERFLOW"))
    }

    fn boot_time_nanoseconds() -> Result<u64, HelperError> {
        let mut time = std::mem::MaybeUninit::<libc::timespec>::zeroed();
        // SAFETY: time 指向完整可写 timespec。
        if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, time.as_mut_ptr()) } != 0 {
            return Err(HelperError::deadline("MONOTONIC_CLOCK"));
        }
        // SAFETY: clock_gettime 成功后已初始化。
        let time = unsafe { time.assume_init() };
        (time.tv_sec as u64).checked_mul(1_000_000_000)
            .and_then(|value| value.checked_add(time.tv_nsec as u64))
            .ok_or_else(|| HelperError::deadline("MONOTONIC_OVERFLOW"))
    }

    fn reject_rootless_user_namespace() -> Result<(), HelperError> {
        let map = fs::read_to_string("/proc/self/uid_map")
            .map_err(|_| HelperError::unsupported("UID_MAP_UNREADABLE"))?;
        let fields = map.lines().next().unwrap_or("").split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 || fields[0] != "0" || fields[1] != "0" || fields[2] != "4294967295" {
            return Err(HelperError::unsupported("ROOTLESS_CONTAINER_UNSUPPORTED"));
        }
        Ok(())
    }

    fn discover_volume_identity(
        root: &codegraph_host_path_helper::path_boundary::ObjectIdentityV1,
    ) -> Result<VolumeIdentityV1, HelperError> {
        let mountinfo = fs::read_to_string("/proc/self/mountinfo")
            .map_err(|_| HelperError::namespace("MOUNTINFO_UNREADABLE"))?;
        let line = mountinfo.lines().find(|line| {
            line.split_whitespace().next().and_then(|value| value.parse::<u64>().ok()) == Some(root.mount_id)
        }).ok_or_else(|| HelperError::namespace("MOUNTINFO_ENTRY_MISSING"))?;
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let separator = fields.iter().position(|field| *field == "-")
            .ok_or_else(|| HelperError::namespace("MOUNTINFO_INVALID"))?;
        if separator + 3 >= fields.len() || fields.len() < 6 {
            return Err(HelperError::namespace("MOUNTINFO_INVALID"));
        }
        let filesystem = fields[separator + 1];
        let source = unescape_mountinfo(fields[separator + 2])?;
        let super_options = fields[separator + 3];
        match filesystem {
            "btrfs" => {
                let subvolume_id = super_options.split(',')
                    .find_map(|option| option.strip_prefix("subvolid="))
                    .and_then(|value| value.parse::<u64>().ok())
                    .ok_or_else(|| HelperError::volume("BTRFS_SUBVOLUME_ID_MISSING"))?;
                Ok(VolumeIdentityV1::Btrfs {
                    device: source,
                    filesystem_uuid: discover_btrfs_uuid(root.device_major, root.device_minor)?,
                    mount_id: root.mount_id,
                    subvolume_id,
                })
            }
            "zfs" => {
                let pool = source.split('/').next().unwrap_or("").to_owned();
                if pool.is_empty() || source.contains('@') || !is_zfs_dataset(&source) {
                    return Err(HelperError::unsupported("ZFS_DATASET_UNSUPPORTED"));
                }
                let dataset_guid = discover_zfs_guid(&source)?;
                Ok(VolumeIdentityV1::Zfs {
                    dataset: source,
                    dataset_guid,
                    mount_id: root.mount_id,
                    pool,
                })
            }
            "overlay" => Err(HelperError::unsupported("OVERLAYFS_UNSUPPORTED")),
            "nfs" | "nfs4" | "cifs" | "fuse" | "fuseblk" => {
                Err(HelperError::unsupported("NETWORK_OR_FUSE_UNSUPPORTED"))
            }
            "ext4" => discover_lvm(root, source, LvmFilesystemV1::Ext4),
            "xfs" => discover_lvm(root, source, LvmFilesystemV1::Xfs),
            _ => Err(HelperError::unsupported("FILESYSTEM_UNSUPPORTED")),
        }
    }

    fn discover_btrfs_uuid(major: u32, minor: u32) -> Result<String, HelperError> {
        let expected = format!("{major}:{minor}");
        let roots = fs::read_dir("/sys/fs/btrfs")
            .map_err(|_| HelperError::volume("BTRFS_SYSFS_UNREADABLE"))?;
        for root in roots.flatten() {
            let uuid = root.file_name().to_string_lossy().into_owned();
            let devices = fs::read_dir(root.path().join("devices"));
            for device in devices.into_iter().flatten().flatten() {
                if fs::read_to_string(device.path().join("dev")).ok().is_some_and(|value| value.trim() == expected) {
                    return Ok(uuid);
                }
            }
        }
        Err(HelperError::volume("BTRFS_UUID_UNRESOLVED"))
    }

    fn discover_zfs_guid(dataset: &str) -> Result<String, HelperError> {
        let spec = CommandSpec::fixed(
            "/usr/sbin/zfs",
            vec![
                "get".into(),
                "-Hp".into(),
                "-o".into(),
                "value".into(),
                "guid".into(),
                dataset.into(),
            ],
            5_000,
        )?;
        let output = SystemCommandExecutor.execute(&spec)?;
        if !output.stderr.is_empty() {
            return Err(HelperError::volume("ZFS_GUID_STDERR"));
        }
        let guid = std::str::from_utf8(&output.stdout)
            .map_err(|_| HelperError::volume("ZFS_GUID_ENCODING"))?
            .trim();
        if guid.is_empty() || guid.len() > 20 ||
            !guid.bytes().all(|byte| byte.is_ascii_digit()) ||
            !guid.parse::<u64>().is_ok_and(|value| value != 0)
        {
            return Err(HelperError::volume("ZFS_GUID_INVALID"));
        }
        Ok(guid.to_owned())
    }

    fn is_zfs_dataset(value: &str) -> bool {
        !value.is_empty() && value.len() <= 240 && value.split('/').all(|component| {
            !component.is_empty() && component.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
            })
        })
    }

    fn discover_lvm(
        root: &codegraph_host_path_helper::path_boundary::ObjectIdentityV1,
        source: String,
        filesystem: LvmFilesystemV1,
    ) -> Result<VolumeIdentityV1, HelperError> {
        let sys = Path::new("/sys/dev/block").join(format!("{}:{}", root.device_major, root.device_minor));
        let dm_uuid = fs::read_to_string(sys.join("dm/uuid"))
            .map_err(|_| HelperError::unsupported("EXT4_XFS_FREEZE_DEFERRED"))?;
        let identity = dm_uuid.trim().strip_prefix("LVM-")
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
            .ok_or_else(|| HelperError::unsupported("EXT4_XFS_FREEZE_DEFERRED"))?;
        // device-mapper 把 32 字节 VG UUID 与 32 字节 LV UUID 无分隔拼接。
        let vg_uuid = identity[..32].to_owned();
        let origin_lv_uuid = identity[32..].to_owned();
        let dm_name = fs::read_to_string(sys.join("dm/name"))
            .map_err(|_| HelperError::volume("LVM_NAME_UNREADABLE"))?;
        let (vg_name, origin_lv) = split_dm_name(dm_name.trim())?;
        Ok(VolumeIdentityV1::Lvm {
            device: source,
            device_major_minor: format!("{}:{}", root.device_major, root.device_minor),
            filesystem,
            mount_id: root.mount_id,
            origin_lv,
            origin_lv_uuid,
            vg_name,
            vg_uuid,
        })
    }

    fn split_dm_name(value: &str) -> Result<(String, String), HelperError> {
        let mut left = String::new();
        let mut right = String::new();
        let mut separator_seen = false;
        let bytes = value.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'-' {
                if bytes.get(index + 1) == Some(&b'-') {
                    (if separator_seen { &mut right } else { &mut left }).push('-');
                    index += 2;
                    continue;
                }
                if separator_seen {
                    return Err(HelperError::volume("LVM_DM_NAME_INVALID"));
                }
                separator_seen = true;
                index += 1;
                continue;
            }
            (if separator_seen { &mut right } else { &mut left }).push(bytes[index] as char);
            index += 1;
        }
        if !separator_seen || left.is_empty() || right.is_empty() {
            return Err(HelperError::volume("LVM_DM_NAME_INVALID"));
        }
        Ok((left, right))
    }

    fn unescape_mountinfo(value: &str) -> Result<String, HelperError> {
        let mut output = String::new();
        let bytes = value.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                let code = bytes.get(index + 1..index + 4)
                    .ok_or_else(|| HelperError::namespace("MOUNTINFO_ESCAPE"))?;
                let decoded = match code {
                    b"040" => ' ',
                    b"011" => '\t',
                    b"012" => '\n',
                    b"134" => '\\',
                    _ => return Err(HelperError::namespace("MOUNTINFO_ESCAPE")),
                };
                output.push(decoded);
                index += 4;
            } else {
                output.push(bytes[index] as char);
                index += 1;
            }
        }
        Ok(output)
    }

    fn backend_name(value: SnapshotBackendKindV1) -> &'static str {
        match value {
            SnapshotBackendKindV1::Btrfs => "btrfs",
            SnapshotBackendKindV1::Lvm => "lvm",
            SnapshotBackendKindV1::Zfs => "zfs",
        }
    }
}

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = linux::main() {
        eprintln!("{}", error.code);
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("LINUX_ONLY");
    std::process::exit(78);
}
