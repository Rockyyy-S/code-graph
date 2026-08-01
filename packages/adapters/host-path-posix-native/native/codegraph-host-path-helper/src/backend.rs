#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};

use crate::{
    command::{CommandExecutor, CommandOutput, CommandSpec},
    engine::{BackendCaptureV1, SnapshotBackend},
    protocol::{
        AuthenticatedRequestV1, HelperError, LvmFilesystemV1, SnapshotBackendKindV1,
        VolumeIdentityV1,
    },
};

const SNAPSHOT_ROOT: &str = "/run/codegraph-host-path/snapshots";
const COMMAND_TIMEOUT_MS: u64 = 20_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotPlanV1 {
    pub cleanup: Vec<CleanupStepV1>,
    pub create: Vec<PlanStepV1>,
    pub postflight: Vec<PlanStepV1>,
    pub request_root: PathBuf,
    pub view_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanStepV1 {
    pub expectation: OutputExpectationV1,
    pub mutation: Option<MutationV1>,
    pub spec: CommandSpec,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupStepV1 {
    pub required_mutation: MutationV1,
    pub spec: CommandSpec,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MutationV1 {
    BtrfsMount,
    BtrfsSnapshot,
    LvmMount,
    LvmSnapshot,
    ZfsMount,
    ZfsSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutputExpectationV1 {
    Any,
    BtrfsNoNested,
    BtrfsFilesystemBinding { filesystem_uuid: String },
    BtrfsSubvolumeBinding { subvolume_id: u64 },
    LvmThinOriginHealthy {
        origin_lv: String,
        origin_lv_uuid: String,
        vg_name: String,
        vg_uuid: String,
    },
    LvmThinSnapshotHealthy {
        origin_lv: String,
        origin_lv_uuid: String,
        snapshot_lv: String,
        vg_name: String,
        vg_uuid: String,
    },
    ZfsDatasetBinding { dataset: String, dataset_guid: String, pool: String },
}

pub struct LinuxSnapshotBackend<E> {
    executor: E,
}

impl<E> LinuxSnapshotBackend<E> {
    pub fn new(executor: E) -> Self {
        Self { executor }
    }

    pub fn into_executor(self) -> E {
        self.executor
    }
}

pub fn plan_snapshot(request: &AuthenticatedRequestV1) -> Result<SnapshotPlanV1, HelperError> {
    if request.volume_identity.backend() != request.snapshot.backend {
        return Err(HelperError::volume("BACKEND_VOLUME_MISMATCH"));
    }
    let request_directory = hex::encode(Sha256::digest(request.request_id.as_bytes()));
    let request_root = Path::new(SNAPSHOT_ROOT).join(&request_directory[..32]);
    let view_root = request_root.join("view");
    match &request.volume_identity {
        VolumeIdentityV1::Btrfs {
            device,
            filesystem_uuid,
            mount_id: _,
            subvolume_id,
        } => plan_btrfs(
            request,
            request_root,
            device,
            filesystem_uuid,
            *subvolume_id,
        ),
        VolumeIdentityV1::Zfs { dataset, dataset_guid, mount_id: _, pool } => {
            plan_zfs(request, request_root, view_root, dataset, dataset_guid, pool)
        }
        VolumeIdentityV1::Lvm {
            device,
            device_major_minor,
            filesystem,
            mount_id: _,
            origin_lv,
            origin_lv_uuid,
            vg_name,
            vg_uuid,
        } => plan_lvm(
            request,
            request_root,
            view_root,
            device,
            device_major_minor,
            *filesystem,
            origin_lv,
            origin_lv_uuid,
            vg_name,
            vg_uuid,
        ),
    }
}

fn plan_btrfs(
    request: &AuthenticatedRequestV1,
    request_root: PathBuf,
    device: &str,
    filesystem_uuid: &str,
    subvolume_id: u64,
) -> Result<SnapshotPlanV1, HelperError> {
    if request.snapshot.backend != SnapshotBackendKindV1::Btrfs ||
        !is_device_path(device) ||
        !is_uuid(filesystem_uuid) ||
        subvolume_id == 0
    {
        return Err(HelperError::unsupported("BTRFS_BINDING_INVALID"));
    }
    let view_root = request_root.join(format!(
        ".codegraph-host-path-{}",
        short_request_id(request),
    ));
    let root_fd_path = "/proc/self/fd/9".to_owned();
    Ok(SnapshotPlanV1 {
        cleanup: vec![
            CleanupStepV1 {
                required_mutation: MutationV1::BtrfsSnapshot,
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec!["subvolume".into(), "delete".into(), view_root_string(&view_root)?],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            CleanupStepV1 {
                required_mutation: MutationV1::BtrfsMount,
                spec: CommandSpec::fixed(
                    "/usr/bin/umount",
                    vec!["--".into(), view_root_string(&request_root)?],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
        ],
        create: vec![
            PlanStepV1 {
                expectation: OutputExpectationV1::BtrfsFilesystemBinding {
                    filesystem_uuid: filesystem_uuid.into(),
                },
                mutation: None,
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec!["filesystem".into(), "show".into(), "--raw".into(), root_fd_path.clone()],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::BtrfsSubvolumeBinding { subvolume_id },
                mutation: None,
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec!["subvolume".into(), "show".into(), "--raw".into(), root_fd_path.clone()],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::BtrfsNoNested,
                mutation: None,
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec!["subvolume".into(), "list".into(), "-o".into(), root_fd_path.clone()],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::Any,
                mutation: Some(MutationV1::BtrfsMount),
                spec: CommandSpec::fixed(
                    "/usr/bin/mount",
                    vec![
                        "-t".into(),
                        "btrfs".into(),
                        "-o".into(),
                        "subvolid=5,nosuid,nodev,noexec".into(),
                        "--".into(),
                        device.into(),
                        view_root_string(&request_root)?,
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::BtrfsFilesystemBinding {
                    filesystem_uuid: filesystem_uuid.into(),
                },
                mutation: None,
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec![
                        "filesystem".into(),
                        "show".into(),
                        "--raw".into(),
                        view_root_string(&request_root)?,
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::BtrfsSubvolumeBinding { subvolume_id: 5 },
                mutation: None,
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec![
                        "subvolume".into(),
                        "show".into(),
                        "--raw".into(),
                        view_root_string(&request_root)?,
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::Any,
                mutation: Some(MutationV1::BtrfsSnapshot),
                spec: CommandSpec::fixed(
                    "/usr/bin/btrfs",
                    vec![
                        "subvolume".into(),
                        "snapshot".into(),
                        "-r".into(),
                        root_fd_path,
                        view_root_string(&view_root)?,
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
        ],
        postflight: vec![],
        request_root,
        view_root,
    })
}

fn plan_zfs(
    request: &AuthenticatedRequestV1,
    request_root: PathBuf,
    view_root: PathBuf,
    dataset: &str,
    dataset_guid: &str,
    pool: &str,
) -> Result<SnapshotPlanV1, HelperError> {
    if request.snapshot.backend != SnapshotBackendKindV1::Zfs ||
        !is_dataset(dataset) ||
        !is_zfs_guid(dataset_guid) ||
        !is_dataset_component(pool) ||
        dataset.split('/').next() != Some(pool)
    {
        return Err(HelperError::unsupported("ZFS_DATASET_INVALID"));
    }
    // 首切片仅启用单 dataset；递归 closure 未经独立 mount-layout 资格化前 fail closed。
    if dataset.contains(',') || dataset.contains('@') {
        return Err(HelperError::unsupported("ZFS_CLOSURE_UNSUPPORTED"));
    }
    let snapshot_name = format!("{}@cg-{}", dataset, short_request_id(request));
    Ok(SnapshotPlanV1 {
        cleanup: vec![
            CleanupStepV1 {
                required_mutation: MutationV1::ZfsMount,
                spec: CommandSpec::fixed(
                    "/usr/bin/umount",
                    vec!["--".into(), view_root_string(&view_root)?],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            CleanupStepV1 {
                required_mutation: MutationV1::ZfsSnapshot,
                spec: CommandSpec::fixed(
                    "/usr/sbin/zfs",
                    vec!["destroy".into(), "--".into(), snapshot_name.clone()],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
        ],
        create: vec![
            PlanStepV1 {
                expectation: OutputExpectationV1::ZfsDatasetBinding {
                    dataset: dataset.into(),
                    dataset_guid: dataset_guid.into(),
                    pool: pool.into(),
                },
                mutation: None,
                spec: CommandSpec::fixed(
                    "/usr/sbin/zfs",
                    vec![
                        "get".into(),
                        "-Hp".into(),
                        "-o".into(),
                        "name,property,value".into(),
                        "type,mounted,readonly,guid".into(),
                        dataset.into(),
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::Any,
                mutation: Some(MutationV1::ZfsSnapshot),
                spec: CommandSpec::fixed(
                    "/usr/sbin/zfs",
                    vec!["snapshot".into(), "--".into(), snapshot_name.clone()],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::Any,
                mutation: Some(MutationV1::ZfsMount),
                spec: CommandSpec::fixed(
                    "/usr/bin/mount",
                    vec![
                        "-t".into(),
                        "zfs".into(),
                        "-o".into(),
                        "ro,nosuid,nodev,noexec".into(),
                        "--".into(),
                        snapshot_name,
                        view_root_string(&view_root)?,
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
        ],
        postflight: vec![],
        request_root,
        view_root,
    })
}

fn plan_lvm(
    request: &AuthenticatedRequestV1,
    request_root: PathBuf,
    view_root: PathBuf,
    device: &str,
    device_major_minor: &str,
    filesystem: LvmFilesystemV1,
    origin_lv: &str,
    origin_lv_uuid: &str,
    vg_name: &str,
    vg_uuid: &str,
) -> Result<SnapshotPlanV1, HelperError> {
    if request.snapshot.backend != SnapshotBackendKindV1::Lvm ||
        !is_device_path(device) ||
        device_major_minor != format!(
            "{}:{}",
            request.root_identity.device_major,
            request.root_identity.device_minor,
        ) ||
        !is_lvm_name(origin_lv) ||
        !is_lvm_name(vg_name) ||
        normalized_lvm_uuid(origin_lv_uuid).is_none() ||
        normalized_lvm_uuid(vg_uuid).is_none()
    {
        return Err(HelperError::unsupported("LVM_BINDING_INVALID"));
    }
    let snapshot_lv = format!("cg_{}", short_request_id(request).replace('-', "_"));
    let snapshot_device = format!("/dev/{vg_name}/{snapshot_lv}");
    let (filesystem_name, mount_options) = match filesystem {
        LvmFilesystemV1::Ext4 => ("ext4", "ro,noload,nosuid,nodev,noexec"),
        LvmFilesystemV1::Xfs => ("xfs", "ro,norecovery,nouuid,nosuid,nodev,noexec"),
    };
    let lvs_args = vec![
        "--reportformat".into(),
        "json".into(),
        "--units".into(),
        "b".into(),
        "--nosuffix".into(),
        "-o".into(),
        "vg_name,vg_uuid,lv_name,lv_uuid,lv_attr,data_percent,metadata_percent,pool_lv,origin_uuid".into(),
        vg_name.into(),
    ];
    // 未绑定 snapshot size 的 thick COW origin 不能安全创建；本切片只启用 thin origin。
    let origin_health = OutputExpectationV1::LvmThinOriginHealthy {
        origin_lv: origin_lv.into(),
        origin_lv_uuid: origin_lv_uuid.into(),
        vg_name: vg_name.into(),
        vg_uuid: vg_uuid.into(),
    };
    let snapshot_health = OutputExpectationV1::LvmThinSnapshotHealthy {
        origin_lv: origin_lv.into(),
        origin_lv_uuid: origin_lv_uuid.into(),
        snapshot_lv: snapshot_lv.clone(),
        vg_name: vg_name.into(),
        vg_uuid: vg_uuid.into(),
    };
    Ok(SnapshotPlanV1 {
        cleanup: vec![
            CleanupStepV1 {
                required_mutation: MutationV1::LvmMount,
                spec: CommandSpec::fixed(
                    "/usr/bin/umount",
                    vec!["--".into(), view_root_string(&view_root)?],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            CleanupStepV1 {
                required_mutation: MutationV1::LvmSnapshot,
                spec: CommandSpec::fixed(
                    "/usr/sbin/lvremove",
                    vec!["--yes".into(), "--".into(), snapshot_device.clone()],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
        ],
        create: vec![
            PlanStepV1 {
                expectation: origin_health,
                mutation: None,
                spec: CommandSpec::fixed("/usr/sbin/lvs", lvs_args.clone(), COMMAND_TIMEOUT_MS)?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::Any,
                mutation: Some(MutationV1::LvmSnapshot),
                spec: CommandSpec::fixed(
                    "/usr/sbin/lvcreate",
                    vec![
                        "--snapshot".into(),
                        "--permission".into(),
                        "r".into(),
                        "--name".into(),
                        snapshot_lv,
                        "--".into(),
                        format!("{vg_name}/{origin_lv}"),
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
            PlanStepV1 {
                expectation: snapshot_health.clone(),
                mutation: None,
                spec: CommandSpec::fixed("/usr/sbin/lvs", lvs_args.clone(), COMMAND_TIMEOUT_MS)?,
            },
            PlanStepV1 {
                expectation: OutputExpectationV1::Any,
                mutation: Some(MutationV1::LvmMount),
                spec: CommandSpec::fixed(
                    "/usr/bin/mount",
                    vec![
                        "-t".into(),
                        filesystem_name.into(),
                        "-o".into(),
                        mount_options.into(),
                        "--".into(),
                        snapshot_device,
                        view_root_string(&view_root)?,
                    ],
                    COMMAND_TIMEOUT_MS,
                )?,
            },
        ],
        // 固定 batch 完成后再次读取 thin pool/snapshot 状态；空间异常使 fence 立即失效。
        postflight: vec![PlanStepV1 {
            expectation: snapshot_health,
            mutation: None,
            spec: CommandSpec::fixed("/usr/sbin/lvs", lvs_args, COMMAND_TIMEOUT_MS)?,
        }],
        request_root,
        view_root,
    })
}

impl<E: CommandExecutor> SnapshotBackend for LinuxSnapshotBackend<E> {
    fn capture(
        &mut self,
        request: &AuthenticatedRequestV1,
        root_fd: i32,
    ) -> Result<BackendCaptureV1, HelperError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (request, root_fd);
            return Err(HelperError::unsupported("LINUX_ONLY"));
        }
        #[cfg(target_os = "linux")]
        {
            use std::{fs, os::fd::AsRawFd, os::unix::fs::PermissionsExt};

            let plan = plan_snapshot(request)?;
            let snapshot_root = Path::new(SNAPSHOT_ROOT);
            if !snapshot_root.is_dir() {
                return Err(HelperError::snapshot("SNAPSHOT_ROOT_MISSING", false));
            }
            fs::create_dir(&plan.request_root)
                .map_err(|_| HelperError::snapshot("SNAPSHOT_DIRECTORY_CREATE", false))?;
            fs::set_permissions(&plan.request_root, fs::Permissions::from_mode(0o700))
                .map_err(|_| HelperError::snapshot("SNAPSHOT_DIRECTORY_MODE", false))?;
            if request.snapshot.backend != SnapshotBackendKindV1::Btrfs {
                fs::create_dir(&plan.view_root)
                    .map_err(|_| HelperError::snapshot("VIEW_DIRECTORY_CREATE", false))?;
            }
            // fd 3 保留给 systemd socket activation；收到的 root FD 只复制到固定 slot 9。
            if root_fd != crate::transport::DAEMON_ROOT_FD {
                let directory_cleanup = cleanup_runtime_directories(&plan, request.snapshot.backend);
                return directory_cleanup.and(Err(HelperError::authentication("ROOT_FD_SLOT_MISMATCH")));
            }
            let mut completed_mutations = BTreeSet::new();
            let capture_result = (|| {
                let mut snapshot_id = None;
                for step in &plan.create {
                    let output = execute_with_request_deadline(
                        &mut self.executor,
                        &step.spec,
                        request.deadline_unix_ms,
                    )?;
                    bind_snapshot_id(&mut snapshot_id, validate_output(&step.expectation, &output)?)?;
                    if let Some(mutation) = step.mutation {
                        completed_mutations.insert(mutation);
                    }
                }
                ensure_request_deadline(request.deadline_unix_ms)?;
                let view = crate::path_boundary::open_directory(&plan.view_root)?;
                let view_identity = crate::path_boundary::stat_identity_fd(view.as_raw_fd())?;
                let (root_object_id, items) = crate::path_boundary::capture_batch(
                    &view,
                    &request.candidates,
                )?;
                ensure_request_deadline(request.deadline_unix_ms)?;
                for step in &plan.postflight {
                    let output = execute_with_request_deadline(
                        &mut self.executor,
                        &step.spec,
                        request.deadline_unix_ms,
                    )?;
                    bind_snapshot_id(&mut snapshot_id, validate_output(&step.expectation, &output)?)?;
                }
                Ok(BackendCaptureV1 {
                    items,
                    root_object_id,
                    snapshot_fence: request.snapshot.fence_id.clone(),
                    snapshot_view: request.snapshot.view_id.clone(),
                    volume_id: capture_volume_id(request, &view_identity, snapshot_id.as_deref())?,
                })
            })();
            let cleanup_result = cleanup_plan(&mut self.executor, &plan, &completed_mutations);
            let directory_cleanup = cleanup_runtime_directories(&plan, request.snapshot.backend);
            match (capture_result, cleanup_result.and(directory_cleanup)) {
                (_, Err(error)) => Err(error),
                (Err(error), Ok(())) => Err(error),
                (Ok(capture), Ok(())) => Ok(capture),
            }
        }
    }
}

fn execute_with_request_deadline<E: CommandExecutor>(
    executor: &mut E,
    spec: &CommandSpec,
    deadline_unix_ms: u64,
) -> Result<CommandOutput, HelperError> {
    let remaining = remaining_request_ms(deadline_unix_ms)?;
    let mut bounded = spec.clone();
    bounded.timeout_ms = bounded.timeout_ms.min(remaining);
    let output = executor.execute(&bounded)?;
    ensure_request_deadline(deadline_unix_ms)?;
    Ok(output)
}

fn ensure_request_deadline(deadline_unix_ms: u64) -> Result<(), HelperError> {
    remaining_request_ms(deadline_unix_ms).map(|_| ())
}

fn remaining_request_ms(deadline_unix_ms: u64) -> Result<u64, HelperError> {
    let now = u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| HelperError::deadline("CLOCK_INVALID"))?
            .as_millis(),
    ).map_err(|_| HelperError::deadline("CLOCK_OVERFLOW"))?;
    deadline_unix_ms.checked_sub(now)
        .filter(|remaining| *remaining > 0)
        .ok_or_else(|| HelperError::deadline("REQUEST_EXPIRED_DURING_CAPTURE"))
}

#[cfg(target_os = "linux")]
fn cleanup_runtime_directories(
    plan: &SnapshotPlanV1,
    backend: SnapshotBackendKindV1,
) -> Result<(), HelperError> {
    use std::fs;

    // 绝不递归删除 mount target；若卸载失败，remove_dir 只会安全地失败并保留证据。
    if backend != SnapshotBackendKindV1::Btrfs && fs::remove_dir(&plan.view_root).is_err() {
        return Err(HelperError::cleanup("VIEW_DIRECTORY_CLEANUP_FAILED"));
    }
    fs::remove_dir(&plan.request_root)
        .map_err(|_| HelperError::cleanup("RUNTIME_DIRECTORY_CLEANUP_FAILED"))
}

fn cleanup_plan<E: CommandExecutor>(
    executor: &mut E,
    plan: &SnapshotPlanV1,
    completed_mutations: &BTreeSet<MutationV1>,
) -> Result<(), HelperError> {
    let mut failed = false;
    for cleanup in &plan.cleanup {
        if completed_mutations.contains(&cleanup.required_mutation) &&
            executor.execute(&cleanup.spec).is_err()
        {
            failed = true;
        }
    }
    if failed {
        Err(HelperError::cleanup("SNAPSHOT_CLEANUP_FAILED"))
    } else {
        Ok(())
    }
}

fn validate_output(
    expectation: &OutputExpectationV1,
    output: &CommandOutput,
) -> Result<Option<String>, HelperError> {
    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| HelperError::snapshot("COMMAND_OUTPUT_ENCODING", false))?;
    match expectation {
        OutputExpectationV1::Any => Ok(None),
        OutputExpectationV1::BtrfsNoNested => {
            if stdout.trim().is_empty() {
                Ok(None)
            } else {
                Err(HelperError::unsupported("BTRFS_NESTED_SUBVOLUME"))
            }
        }
        OutputExpectationV1::BtrfsFilesystemBinding { filesystem_uuid } => {
            if stdout.lines().any(|line| output_has_token_value(line, "uuid:", filesystem_uuid)) {
                Ok(None)
            } else {
                Err(HelperError::volume("BTRFS_FILESYSTEM_DRIFT"))
            }
        }
        OutputExpectationV1::BtrfsSubvolumeBinding { subvolume_id } => {
            let id = subvolume_id.to_string();
            if stdout.lines().any(|line| {
                line.trim_start().to_ascii_lowercase().starts_with("subvolume id:") &&
                    line.split_once(':').is_some_and(|(_, value)| {
                        value.split_whitespace().next() == Some(id.as_str())
                    })
            }) {
                Ok(None)
            } else {
                Err(HelperError::volume("BTRFS_SUBVOLUME_DRIFT"))
            }
        }
        OutputExpectationV1::ZfsDatasetBinding { dataset, dataset_guid, pool } => {
            let properties = stdout.lines().filter_map(|line| {
                let mut fields = line.split('\t');
                let name = fields.next()?;
                let property = fields.next()?;
                let value = fields.next()?;
                (fields.next().is_none() && name == dataset).then_some((property, value))
            }).collect::<std::collections::BTreeMap<_, _>>();
            if dataset.split('/').next() == Some(pool) &&
                properties.get("type") == Some(&"filesystem") &&
                properties.get("mounted") == Some(&"yes") &&
                matches!(properties.get("readonly"), Some(&"on") | Some(&"off")) &&
                properties.get("guid") == Some(&dataset_guid.as_str())
            {
                Ok(None)
            } else {
                Err(HelperError::volume("ZFS_DATASET_DRIFT"))
            }
        }
        OutputExpectationV1::LvmThinOriginHealthy {
            origin_lv,
            origin_lv_uuid,
            vg_name,
            vg_uuid,
        } => {
            validate_lvm_health(stdout, vg_name, vg_uuid, origin_lv, origin_lv_uuid, None)
        }
        OutputExpectationV1::LvmThinSnapshotHealthy {
            origin_lv,
            origin_lv_uuid,
            snapshot_lv,
            vg_name,
            vg_uuid,
        } => validate_lvm_health(
            stdout,
            vg_name,
            vg_uuid,
            origin_lv,
            origin_lv_uuid,
            Some(snapshot_lv),
        ),
    }
}

fn validate_lvm_health(
    stdout: &str,
    vg_name: &str,
    vg_uuid: &str,
    origin_lv: &str,
    origin_lv_uuid: &str,
    snapshot_lv: Option<&str>,
) -> Result<Option<String>, HelperError> {
    let value: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|_| HelperError::snapshot("LVM_REPORT_INVALID", false))?;
    let lvs = value.get("report")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .flat_map(|report| report.get("lv").and_then(|value| value.as_array()).into_iter().flatten())
        .collect::<Vec<_>>();
    let origin = lvs.iter().copied().find(|lv| {
        value_string(lv, "vg_name") == vg_name &&
            lvm_uuid_matches(value_string(lv, "vg_uuid"), vg_uuid) &&
            value_string(lv, "lv_name") == origin_lv &&
            lvm_uuid_matches(value_string(lv, "lv_uuid"), origin_lv_uuid)
    }).ok_or_else(|| HelperError::volume("LVM_ORIGIN_UUID_DRIFT"))?;
    let origin_attr = value_string(origin, "lv_attr");
    let pool_name = value_string(origin, "pool_lv");
    if !origin_attr.starts_with('V') || !is_lvm_name(pool_name) {
        return Err(HelperError::unsupported("LVM_THICK_ORIGIN_UNSUPPORTED"));
    }
    validate_lvm_lv_health(origin)?;
    let pool = lvs.iter().copied().find(|lv| {
        value_string(lv, "vg_name") == vg_name &&
            lvm_uuid_matches(value_string(lv, "vg_uuid"), vg_uuid) &&
            value_string(lv, "lv_name") == pool_name
    }).ok_or_else(|| HelperError::snapshot("LVM_THIN_POOL_MISSING", false))?;
    if !value_string(pool, "lv_attr").starts_with('t') ||
        percentage_value(pool.get("data_percent")).is_none() ||
        percentage_value(pool.get("metadata_percent")).is_none()
    {
        return Err(HelperError::snapshot("LVM_THIN_POOL_INVALID", false));
    }
    validate_lvm_lv_health(pool)?;
    let Some(snapshot_lv) = snapshot_lv else {
        return Ok(None);
    };
    let snapshot = lvs.iter().copied().find(|lv| {
        value_string(lv, "vg_name") == vg_name &&
            lvm_uuid_matches(value_string(lv, "vg_uuid"), vg_uuid) &&
            value_string(lv, "lv_name") == snapshot_lv &&
            lvm_uuid_matches(value_string(lv, "origin_uuid"), origin_lv_uuid)
    }).ok_or_else(|| HelperError::volume("LVM_SNAPSHOT_BINDING_DRIFT"))?;
    if !value_string(snapshot, "lv_attr").starts_with('V') ||
        value_string(snapshot, "pool_lv") != pool_name
    {
        return Err(HelperError::volume("LVM_SNAPSHOT_BINDING_DRIFT"));
    }
    validate_lvm_lv_health(snapshot)?;
    let snapshot_uuid = value_string(snapshot, "lv_uuid");
    if lvm_uuid_matches(snapshot_uuid, origin_lv_uuid) || normalized_lvm_uuid(snapshot_uuid).is_none() {
        return Err(HelperError::volume("LVM_SNAPSHOT_UUID_INVALID"));
    }
    Ok(normalized_lvm_uuid(snapshot_uuid))
}

fn validate_lvm_lv_health(lv: &serde_json::Value) -> Result<(), HelperError> {
    if value_string(lv, "lv_attr").contains('I') ||
        percentage_at_or_above(lv.get("data_percent"), 95.0) ||
        percentage_at_or_above(lv.get("metadata_percent"), 95.0)
    {
        return Err(HelperError::snapshot("LVM_SNAPSHOT_SPACE_INVALID", false));
    }
    Ok(())
}

fn percentage_at_or_above(value: Option<&serde_json::Value>, limit: f64) -> bool {
    percentage_value(value)
        .is_some_and(|value| !value.is_finite() || value >= limit)
}

fn percentage_value(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|value| value.as_str().and_then(|value| value.parse::<f64>().ok()).or_else(|| value.as_f64()))
}

fn value_string<'a>(value: &'a serde_json::Value, field: &str) -> &'a str {
    value.get(field).and_then(|value| value.as_str()).unwrap_or("")
}

fn output_has_token_value(line: &str, label: &str, expected: &str) -> bool {
    let fields = line.split_whitespace().collect::<Vec<_>>();
    fields.windows(2).any(|pair| pair[0].eq_ignore_ascii_case(label) && pair[1] == expected)
}

fn bind_snapshot_id(bound: &mut Option<String>, candidate: Option<String>) -> Result<(), HelperError> {
    if let Some(candidate) = candidate {
        if bound.as_ref().is_some_and(|bound| bound != &candidate) {
            return Err(HelperError::volume("SNAPSHOT_ID_DRIFT"));
        }
        *bound = Some(candidate);
    }
    Ok(())
}

fn capture_volume_id(
    request: &AuthenticatedRequestV1,
    view: &crate::path_boundary::ObjectIdentityV1,
    snapshot_id: Option<&str>,
) -> Result<String, HelperError> {
    let volume_digest = crate::canonical::canonical_sha256(&request.volume_identity)?;
    let snapshot_suffix = match request.snapshot.backend {
        SnapshotBackendKindV1::Lvm => snapshot_id
            .ok_or_else(|| HelperError::volume("LVM_SNAPSHOT_ID_MISSING"))?,
        SnapshotBackendKindV1::Btrfs | SnapshotBackendKindV1::Zfs => &request.snapshot.view_id,
    };
    Ok(format!(
        "{}:{}:{}:{}:{}",
        backend_name(request.snapshot.backend),
        volume_digest,
        snapshot_suffix,
        view.device_major,
        view.device_minor,
    ))
}

fn short_request_id(request: &AuthenticatedRequestV1) -> String {
    hex::encode(Sha256::digest(request.request_id.as_bytes()))[..20].to_owned()
}

fn view_root_string(path: &Path) -> Result<String, HelperError> {
    path.to_str().map(str::to_owned).ok_or_else(|| HelperError::protocol("VIEW_PATH_ENCODING"))
}

fn backend_name(value: SnapshotBackendKindV1) -> &'static str {
    match value {
        SnapshotBackendKindV1::Btrfs => "btrfs",
        SnapshotBackendKindV1::Lvm => "lvm",
        SnapshotBackendKindV1::Zfs => "zfs",
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) && byte == b'-' ||
            !matches!(index, 8 | 13 | 18 | 23) && byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
    })
}

fn is_dataset(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240 && value.split('/').all(is_dataset_component)
}

fn is_dataset_component(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
    })
}

fn is_zfs_guid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 &&
        value.bytes().all(|byte| byte.is_ascii_digit()) &&
        value.parse::<u64>().is_ok_and(|value| value != 0)
}

fn is_device_path(value: &str) -> bool {
    value.starts_with("/dev/") && value.len() <= 255 && value.split('/').skip(1).all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".." && segment.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'+' | b':')
        })
    })
}

fn is_lvm_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 127 && value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'+')
    })
}

fn normalized_lvm_uuid(value: &str) -> Option<String> {
    let normalized = value.bytes().filter(|byte| *byte != b'-').collect::<Vec<_>>();
    (normalized.len() == 32 && normalized.iter().all(u8::is_ascii_alphanumeric))
        .then(|| String::from_utf8(normalized).expect("validated ASCII LVM UUID"))
}

fn lvm_uuid_matches(left: &str, right: &str) -> bool {
    normalized_lvm_uuid(left).zip(normalized_lvm_uuid(right))
        .is_some_and(|(left, right)| left == right)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use crate::{
        canonical::canonical_sha256,
        protocol::{
            ABI_VERSION, AuthenticatedRequestV1, BridgeCandidateV1,
            INSTALL_PROVENANCE_SCHEMA_VERSION, InstallProvenanceV2,
            MountNamespaceV1, PeerIdentityV1, PROTOCOL_VERSION, RootIdentityV1,
            LvmFilesystemV1, SnapshotBackendKindV1, SnapshotBindingV1, VolumeIdentityV1,
        },
    };

    use super::{MutationV1, OutputExpectationV1, cleanup_plan, plan_snapshot, validate_output};
    use crate::command::{CommandOutput, testing::FakeCommandExecutor};

    fn request(volume_identity: VolumeIdentityV1, backend: SnapshotBackendKindV1) -> AuthenticatedRequestV1 {
        let candidates = vec![BridgeCandidateV1 {
            asserted_relative_path: "a.ts".into(),
            candidate_index: 0,
            logical_path: "a.ts".into(),
            trusted_relative_path: "a.ts".into(),
        }];
        AuthenticatedRequestV1 {
            abi_version: ABI_VERSION,
            batch_digest: canonical_sha256(&candidates).expect("batch"),
            boot_id: "boot-1".into(),
            candidates,
            capability_digest: "a".repeat(64),
            client_request_digest: "b".repeat(64),
            daemon_epoch: "epoch-1".into(),
            deadline_unix_ms: 2,
            issued_at_unix_ms: 1,
            mount_namespace: MountNamespaceV1 { inode: 1, root_mount_id: 11 },
            nonce: "nonce-1".into(),
            peer: PeerIdentityV1 { gid: 1, pid: 1, start_time_ticks: 1, uid: 1 },
            protocol_version: PROTOCOL_VERSION,
            provenance: InstallProvenanceV2 {
                bridge_binary_sha256: "c".repeat(64),
                daemon_binary_sha256: "d".repeat(64),
                manifest_sha256: "d".repeat(64),
                schema_version: INSTALL_PROVENANCE_SCHEMA_VERSION,
                signature: "e".repeat(128),
                signature_key_id: "key-1".into(),
                signer_id: "signer-1".into(),
            },
            request_id: "request-1".into(),
            root_identity: RootIdentityV1 {
                device_major: 8,
                device_minor: 1,
                inode: 2,
                mount_id: 11,
                root_handle_digest: "f".repeat(64),
            },
            sequence: 1,
            snapshot: SnapshotBindingV1 {
                backend,
                fence_id: "fence-1".into(),
                view_id: "view-1".into(),
            },
            volume_identity,
        }
    }

    #[test]
    fn planners_use_only_fixed_executable_and_argv() {
        let fixtures = [
            request(
                VolumeIdentityV1::Btrfs {
                    device: "/dev/sda1".into(),
                    filesystem_uuid: "11111111-1111-1111-1111-111111111111".into(),
                    mount_id: 11,
                    subvolume_id: 5,
                },
                SnapshotBackendKindV1::Btrfs,
            ),
            request(
                VolumeIdentityV1::Zfs {
                    dataset: "tank/repo".into(),
                    dataset_guid: "123456789".into(),
                    mount_id: 11,
                    pool: "tank".into(),
                },
                SnapshotBackendKindV1::Zfs,
            ),
            request(
                VolumeIdentityV1::Lvm {
                    device: "/dev/vg/repo".into(),
                    device_major_minor: "8:1".into(),
                    filesystem: LvmFilesystemV1::Ext4,
                    mount_id: 11,
                    origin_lv: "repo".into(),
                    origin_lv_uuid: "A".repeat(32),
                    vg_name: "vg".into(),
                    vg_uuid: "B".repeat(32),
                },
                SnapshotBackendKindV1::Lvm,
            ),
        ];
        for fixture in fixtures {
            let plan = plan_snapshot(&fixture).expect("plan");
            assert!(plan.create.iter().all(|step| step.spec.executable.starts_with("/usr/")));
            assert!(plan.create.iter().all(|step| !step.spec.args.iter().any(|arg| arg.contains(";"))));
            assert!(!plan.cleanup.is_empty());
            assert!(plan.cleanup.iter().all(|step| step.spec.executable.starts_with("/usr/")));
        }
    }

    #[test]
    fn btrfs_uses_a_private_same_filesystem_top_level_mount() {
        let plan = plan_snapshot(&request(
            VolumeIdentityV1::Btrfs {
                device: "/dev/sda1".into(),
                filesystem_uuid: "11111111-1111-1111-1111-111111111111".into(),
                mount_id: 11,
                subvolume_id: 256,
            },
            SnapshotBackendKindV1::Btrfs,
        )).expect("btrfs plan");
        let mount_index = plan.create.iter().position(|step| {
            step.spec.executable == "/usr/bin/mount" &&
                step.spec.args.iter().any(|arg| arg == "subvolid=5,nosuid,nodev,noexec")
        }).expect("top-level mount");
        let snapshot_index = plan.create.iter().position(|step| {
            step.spec.executable == "/usr/bin/btrfs" &&
                step.spec.args.get(1).is_some_and(|arg| arg == "snapshot")
        }).expect("readonly snapshot");
        assert!(mount_index < snapshot_index);
        assert!(plan.cleanup.iter().any(|step| step.spec.executable == "/usr/bin/umount"));
        assert!(plan.postflight.is_empty());
    }

    #[test]
    fn cleanup_only_runs_for_resources_created_by_this_request() {
        let plan = plan_snapshot(&request(
            VolumeIdentityV1::Zfs {
                dataset: "tank/repo".into(),
                dataset_guid: "123456789".into(),
                mount_id: 11,
                pool: "tank".into(),
            },
            SnapshotBackendKindV1::Zfs,
        )).expect("zfs plan");
        let mut executor = FakeCommandExecutor::default();
        cleanup_plan(&mut executor, &plan, &BTreeSet::new()).expect("no-op cleanup");
        assert!(executor.calls.is_empty());

        cleanup_plan(
            &mut executor,
            &plan,
            &BTreeSet::from([MutationV1::ZfsSnapshot]),
        ).expect("snapshot cleanup");
        assert_eq!(executor.calls.len(), 1);
        assert_eq!(executor.calls[0].executable, "/usr/sbin/zfs");
        assert_eq!(executor.calls[0].args.first().map(String::as_str), Some("destroy"));
    }

    #[test]
    fn lvm_plan_is_thin_only_and_checks_snapshot_after_the_batch() {
        let plan = plan_snapshot(&request(
            VolumeIdentityV1::Lvm {
                device: "/dev/vg/repo".into(),
                device_major_minor: "8:1".into(),
                filesystem: LvmFilesystemV1::Xfs,
                mount_id: 11,
                origin_lv: "repo".into(),
                origin_lv_uuid: "O".repeat(32),
                vg_name: "vg".into(),
                vg_uuid: "V".repeat(32),
            },
            SnapshotBackendKindV1::Lvm,
        )).expect("lvm plan");
        assert_eq!(plan.postflight.len(), 1);
        assert_eq!(plan.postflight[0].spec.executable, "/usr/sbin/lvs");
        assert!(!plan.create.iter().any(|step| {
            step.spec.executable == "/usr/sbin/lvcreate" &&
                step.spec.args.iter().any(|arg| arg == "--size")
        }));
        assert!(plan.create.iter().any(|step| {
            step.spec.executable == "/usr/bin/mount" &&
                step.spec.args.iter().any(|arg| {
                    arg == "ro,norecovery,nouuid,nosuid,nodev,noexec"
                })
        }));
    }

    #[test]
    fn nested_btrfs_and_lvm_space_fail_closed() {
        assert_eq!(
            validate_output(
                &OutputExpectationV1::BtrfsNoNested,
                &CommandOutput { stderr: vec![], stdout: b"ID 8 gen 1 path nested\n".to_vec() },
            ).expect_err("nested").code,
            "BTRFS_NESTED_SUBVOLUME"
        );
        let origin_uuid = "O".repeat(32);
        let vg_uuid = "V".repeat(32);
        let unhealthy = serde_json::to_vec(&serde_json::json!({"report":[{"lv":[
            {"vg_name":"vg","vg_uuid":vg_uuid,"lv_name":"origin","lv_uuid":origin_uuid,"lv_attr":"Vwi-a-tz--","data_percent":"1.00","metadata_percent":"","pool_lv":"pool","origin_uuid":""},
            {"vg_name":"vg","vg_uuid":"V".repeat(32),"lv_name":"pool","lv_uuid":"P".repeat(32),"lv_attr":"twi-I-tz--","data_percent":"100.00","metadata_percent":"1.00","pool_lv":"","origin_uuid":""}
        ]}]})).expect("report");
        assert_eq!(
            validate_output(
                &OutputExpectationV1::LvmThinOriginHealthy {
                    origin_lv: "origin".into(),
                    origin_lv_uuid: "O".repeat(32),
                    vg_name: "vg".into(),
                    vg_uuid: "V".repeat(32),
                },
                &CommandOutput { stderr: vec![], stdout: unhealthy },
            ).expect_err("space").code,
            "LVM_SNAPSHOT_SPACE_INVALID"
        );
    }

    #[test]
    fn lvm_thick_origin_is_rejected_and_snapshot_uuid_is_bound() {
        let origin_uuid = "O".repeat(32);
        let vg_uuid = "V".repeat(32);
        let thick = serde_json::to_vec(&serde_json::json!({"report":[{"lv":[
            {"vg_name":"vg","vg_uuid":vg_uuid,"lv_name":"origin","lv_uuid":origin_uuid,"lv_attr":"-wi-a-----","data_percent":"","metadata_percent":"","pool_lv":"","origin_uuid":""}
        ]}]})).expect("thick report");
        assert_eq!(
            validate_output(
                &OutputExpectationV1::LvmThinOriginHealthy {
                    origin_lv: "origin".into(),
                    origin_lv_uuid: "O".repeat(32),
                    vg_name: "vg".into(),
                    vg_uuid: "V".repeat(32),
                },
                &CommandOutput { stderr: vec![], stdout: thick },
            ).expect_err("thick").code,
            "LVM_THICK_ORIGIN_UNSUPPORTED",
        );

        let healthy = serde_json::to_vec(&serde_json::json!({"report":[{"lv":[
            {"vg_name":"vg","vg_uuid":"V".repeat(32),"lv_name":"origin","lv_uuid":"O".repeat(32),"lv_attr":"Vwi-a-tz--","data_percent":"1.00","metadata_percent":"","pool_lv":"pool","origin_uuid":""},
            {"vg_name":"vg","vg_uuid":"V".repeat(32),"lv_name":"pool","lv_uuid":"P".repeat(32),"lv_attr":"twi-a-tz--","data_percent":"10.00","metadata_percent":"5.00","pool_lv":"","origin_uuid":""},
            {"vg_name":"vg","vg_uuid":"V".repeat(32),"lv_name":"snapshot","lv_uuid":"S".repeat(32),"lv_attr":"Vri-a-tz--","data_percent":"1.00","metadata_percent":"","pool_lv":"pool","origin_uuid":"O".repeat(32)}
        ]}]})).expect("healthy report");
        assert_eq!(
            validate_output(
                &OutputExpectationV1::LvmThinSnapshotHealthy {
                    origin_lv: "origin".into(),
                    origin_lv_uuid: "O".repeat(32),
                    snapshot_lv: "snapshot".into(),
                    vg_name: "vg".into(),
                    vg_uuid: "V".repeat(32),
                },
                &CommandOutput { stderr: vec![], stdout: healthy },
            ).expect("healthy"),
            Some("S".repeat(32)),
        );
    }
}
