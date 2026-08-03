use crate::protocol::HelperError;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectIdentityV1 {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: u64,
    pub mount_id: u64,
}

impl ObjectIdentityV1 {
    pub fn opaque_id(&self) -> String {
        format!("{}:{}:{}:{}", self.device_major, self.device_minor, self.mount_id, self.inode)
    }
}

/// 将 indexing root 在当前 mount 中的位置还原为卷根相对偏移，避免 snapshot 根下同名路径被误读。
pub fn project_indexing_root_offset(
    mount_root: &str,
    mount_point: &str,
    indexing_root: &str,
) -> Result<String, HelperError> {
    let mount_root = canonical_absolute_components(mount_root)?;
    let mount_point = canonical_absolute_components(mount_point)?;
    let indexing_root = canonical_absolute_components(indexing_root)?;
    if !indexing_root.starts_with(&mount_point) {
        return Err(HelperError::namespace("INDEXING_ROOT_MOUNT_DRIFT"));
    }
    Ok(mount_root.into_iter()
        .chain(indexing_root.into_iter().skip(mount_point.len()))
        .collect::<Vec<_>>()
        .join("/"))
}

/// 只允许 canonical 卷根相对路径参与 snapshot 投影，禁止绝对路径或 `..` 替换挂载根。
pub fn project_snapshot_view_root(
    snapshot_mount_root: &Path,
    indexing_root_offset: &str,
) -> Result<PathBuf, HelperError> {
    if indexing_root_offset.is_empty() {
        return Ok(snapshot_mount_root.to_path_buf());
    }
    if indexing_root_offset.starts_with('/') ||
        indexing_root_offset.as_bytes().contains(&0) ||
        indexing_root_offset.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(HelperError::path("INDEXING_ROOT_OFFSET_INVALID"));
    }
    Ok(snapshot_mount_root.join(indexing_root_offset))
}

fn canonical_absolute_components(value: &str) -> Result<Vec<&str>, HelperError> {
    if !value.starts_with('/') || value.as_bytes().contains(&0) {
        return Err(HelperError::namespace("MOUNT_PATH_INVALID"));
    }
    if value == "/" {
        return Ok(Vec::new());
    }
    let components = value[1..].split('/').collect::<Vec<_>>();
    if components.iter().any(|component| component.is_empty() || *component == "." || *component == "..") {
        return Err(HelperError::namespace("MOUNT_PATH_INVALID"));
    }
    Ok(components)
}

#[cfg(test)]
mod projection_tests {
    use std::path::Path;

    use super::{project_indexing_root_offset, project_snapshot_view_root};

    #[test]
    fn projects_mount_root_and_nested_indexing_root_into_snapshot() {
        let offset = project_indexing_root_offset(
            "/datasets/repository",
            "/workspace",
            "/workspace/packages/app",
        ).expect("offset");
        assert_eq!(offset, "datasets/repository/packages/app");
        assert_eq!(
            project_snapshot_view_root(Path::new("/snapshot"), &offset).expect("view"),
            Path::new("/snapshot/datasets/repository/packages/app"),
        );
    }

    #[test]
    fn rejects_indexing_root_outside_observed_mount() {
        assert_eq!(
            project_indexing_root_offset("/", "/workspace", "/other/repository")
                .expect_err("mount drift")
                .code,
            "INDEXING_ROOT_MOUNT_DRIFT",
        );
        assert!(project_snapshot_view_root(Path::new("/snapshot"), "../foreign").is_err());
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        ffi::CString,
        io,
        mem::MaybeUninit,
        os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        path::Path,
    };

    use super::{HelperError, ObjectIdentityV1};
    use crate::protocol::{BridgeCandidateV1, CaptureItemV1};

    const RESOLVE_NO_XDEV: u64 = 0x01;
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_BENEATH: u64 = 0x08;

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    /// 从真实 FD 读取 statx mount ID；绝不从路径字符串恢复 root 身份。
    pub fn stat_identity_fd(fd: RawFd) -> Result<ObjectIdentityV1, HelperError> {
        let empty = CString::new("").expect("empty CString");
        let mut stat = MaybeUninit::<libc::statx>::zeroed();
        // SAFETY: stat 指向完整可写 statx，empty 在调用期间有效，fd 由调用者持有。
        let result = unsafe {
            libc::statx(
                fd,
                empty.as_ptr(),
                libc::AT_EMPTY_PATH | libc::AT_STATX_SYNC_AS_STAT,
                libc::STATX_TYPE | libc::STATX_INO | libc::STATX_MNT_ID,
                stat.as_mut_ptr(),
            )
        };
        if result != 0 {
            return Err(map_io("STATX_FAILED", io::Error::last_os_error()));
        }
        // SAFETY: statx 成功后内核已初始化结构体。
        let stat = unsafe { stat.assume_init() };
        if stat.stx_mask & (libc::STATX_INO | libc::STATX_MNT_ID) !=
            (libc::STATX_INO | libc::STATX_MNT_ID)
        {
            return Err(HelperError::unsupported("STATX_MOUNT_ID_UNAVAILABLE"));
        }
        Ok(ObjectIdentityV1 {
            device_major: stat.stx_dev_major,
            device_minor: stat.stx_dev_minor,
            inode: stat.stx_ino,
            mount_id: stat.stx_mnt_id,
        })
    }

    /// 等价于 openat2 RESOLVE_BENEATH|NO_MAGICLINKS|NO_XDEV 的唯一候选打开边界。
    pub fn open_beneath(root_fd: RawFd, relative_path: &str) -> Result<OwnedFd, HelperError> {
        if relative_path.starts_with('/') ||
            relative_path.as_bytes().contains(&0) ||
            relative_path.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(HelperError::path("PATH_NOT_BENEATH"));
        }
        let path = CString::new(relative_path).map_err(|_| HelperError::path("PATH_NUL"))?;
        let how = OpenHow {
            flags: (libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
        };
        // SAFETY: open_how 与 path 均在 syscall 期间有效，size 与结构体精确匹配。
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root_fd,
                path.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            ) as RawFd
        };
        if fd < 0 {
            return Err(map_openat2(io::Error::last_os_error()));
        }
        // SAFETY: fd 是本函数新获得且唯一拥有的描述符。
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    pub fn open_directory(path: &Path) -> Result<OwnedFd, HelperError> {
        let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
        let path = CString::new(bytes).map_err(|_| HelperError::path("VIEW_PATH_NUL"))?;
        // SAFETY: path 在 open 调用期间有效。
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(map_io("VIEW_OPEN_FAILED", io::Error::last_os_error()));
        }
        // SAFETY: fd 是本函数新获得且唯一拥有的描述符。
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    pub fn capture_batch(
        view_root: &OwnedFd,
        candidates: &[BridgeCandidateV1],
    ) -> Result<(String, Vec<CaptureItemV1>), HelperError> {
        let root_identity = stat_identity_fd(view_root.as_raw_fd())?;
        let mut items = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let trusted = open_beneath(view_root.as_raw_fd(), &candidate.trusted_relative_path)?;
            let asserted = open_beneath(view_root.as_raw_fd(), &candidate.asserted_relative_path)?;
            let trusted_identity = stat_identity_fd(trusted.as_raw_fd())?;
            let asserted_identity = stat_identity_fd(asserted.as_raw_fd())?;
            if trusted_identity.mount_id != root_identity.mount_id ||
                asserted_identity.mount_id != root_identity.mount_id
            {
                return Err(HelperError::volume("CANDIDATE_MOUNT_DRIFT"));
            }
            if trusted_identity != asserted_identity {
                return Err(HelperError::path("LOGICAL_MAPPING_MISMATCH"));
            }
            items.push(CaptureItemV1 {
                candidate_index: candidate.candidate_index,
                object_id: trusted_identity.opaque_id(),
            });
        }
        Ok((root_identity.opaque_id(), items))
    }

    fn map_openat2(error: io::Error) -> HelperError {
        match error.raw_os_error() {
            Some(libc::EXDEV) => HelperError::path("PATH_CROSSES_MOUNT"),
            Some(libc::ELOOP) => HelperError::path("PATH_MAGICLINK_OR_SYMLINK"),
            Some(libc::ENOENT) => HelperError::path("PATH_MISSING"),
            Some(libc::EACCES) | Some(libc::EPERM) => HelperError::path("PATH_UNREADABLE"),
            Some(libc::ENOSYS) => HelperError::unsupported("OPENAT2_UNAVAILABLE"),
            _ => HelperError::path("OPENAT2_FAILED"),
        }
    }

    fn map_io(code: &'static str, error: io::Error) -> HelperError {
        match error.raw_os_error() {
            Some(libc::ENOENT) => HelperError::path("PATH_MISSING"),
            Some(libc::EACCES) | Some(libc::EPERM) => HelperError::path("PATH_UNREADABLE"),
            _ => HelperError::path(code),
        }
    }

    #[cfg(test)]
    mod tests {
        use std::{fs, os::fd::AsRawFd};

        use tempfile::tempdir;

        use super::{capture_batch, open_beneath, open_directory};
        use crate::protocol::BridgeCandidateV1;

        #[test]
        fn openat2_rejects_parent_and_cross_root_links() {
            let root = tempdir().expect("root");
            let outside = tempdir().expect("outside");
            fs::write(root.path().join("inside.ts"), b"inside").expect("inside");
            fs::write(outside.path().join("outside.ts"), b"outside").expect("outside");
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).expect("link");
            let root_fd = open_directory(root.path()).expect("root fd");

            assert!(open_beneath(root_fd.as_raw_fd(), "../outside.ts").is_err());
            assert!(open_beneath(root_fd.as_raw_fd(), "escape/outside.ts").is_err());
            let candidate = BridgeCandidateV1 {
                asserted_relative_path: "inside.ts".into(),
                candidate_index: 0,
                logical_path: "inside.ts".into(),
                trusted_relative_path: "inside.ts".into(),
            };
            let (_, items) = capture_batch(&root_fd, &[candidate]).expect("capture");
            assert_eq!(items.len(), 1);
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{capture_batch, open_beneath, open_directory, stat_identity_fd};

#[cfg(not(target_os = "linux"))]
pub fn unsupported_on_non_linux() -> Result<(), HelperError> {
    Err(HelperError::unsupported("LINUX_ONLY"))
}
