#[cfg(target_os = "linux")]
mod linux {
    use std::{
        env,
        fs::{self, OpenOptions},
        io::Write,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::{fs::OpenOptionsExt, net::{UnixListener, UnixStream}},
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use codegraph_host_path_helper::{
        CaptureEngine,
        backend::LinuxSnapshotBackend,
        canonical::{canonical_json, decode_frame, encode_frame},
        command::SystemCommandExecutor,
        path_boundary::stat_identity_fd,
        protocol::{AuthenticatedRequestEnvelopeV1, HelperError, InstallProvenanceV2},
        security::{
            ExecutableRoleV2, ObservedRootV1, SecurityPolicyV1,
            validate_running_executable_provenance,
        },
        transport::{
            DAEMON_ROOT_FD, duplicate_to_daemon_root_fd, observed_peer,
            receive_frame_with_fd, write_frame,
        },
    };
    use ed25519_dalek::VerifyingKey;
    use sha2::{Digest, Sha256};

    const SOCKET_PATH: &str = "/run/codegraph-host-path/helper.sock";
    const KEY_PATH: &str = "/etc/codegraph-host-path/client.key";
    const PROVENANCE_PATH: &str = "/usr/share/codegraph-host-path/provenance.json";
    const PUBLIC_KEY_PATH: &str = "/usr/share/codegraph-host-path/release.pub";

    struct Args {
        key_path: PathBuf,
        provenance_path: PathBuf,
        public_key_path: PathBuf,
        socket_path: PathBuf,
    }

    struct DaemonRootFdLease;

    impl Drop for DaemonRootFdLease {
        fn drop(&mut self) {
            // SAFETY: daemon 单线程处理连接，fd 9 是本次请求独占的复制租约。
            unsafe { libc::close(DAEMON_ROOT_FD) };
        }
    }

    pub fn main() -> Result<(), HelperError> {
        let args = parse_args(env::args().skip(1).collect())?;
        let public_key = VerifyingKey::from_bytes(
            &read_hex(&args.public_key_path, 32)?
                .try_into()
                .map_err(|_| HelperError::authentication("PUBLIC_KEY_INVALID"))?,
        ).map_err(|_| HelperError::authentication("PUBLIC_KEY_INVALID"))?;
        let expected_provenance: InstallProvenanceV2 = read_canonical_json(&args.provenance_path)?;
        validate_running_executable_provenance(
            &expected_provenance,
            &public_key,
            ExecutableRoleV2::Daemon,
        )?;
        let boot_id = read_token(Path::new("/proc/sys/kernel/random/boot_id"))?;
        let transcript_key = read_hex(&args.key_path, 32)?;
        let daemon_epoch = create_daemon_epoch(&boot_id, &args.socket_path)?;
        let policy = SecurityPolicyV1 {
            boot_id,
            daemon_epoch,
            expected_provenance,
            install_public_key: public_key,
            max_clock_skew_ms: 2_000,
            transcript_key,
        };
        let listener = acquire_listener(&args.socket_path)?;
        let backend = LinuxSnapshotBackend::new(SystemCommandExecutor);
        let mut engine = CaptureEngine::new(backend, policy, 8_192)?;
        for connection in listener.incoming() {
            let mut stream = connection.map_err(|_| HelperError::protocol("SOCKET_ACCEPT"))?;
            if let Err(error) = handle_connection(&mut stream, &mut engine) {
                eprintln!("{}", error.code);
            }
        }
        Ok(())
    }

    fn handle_connection(
        stream: &mut UnixStream,
        engine: &mut CaptureEngine<LinuxSnapshotBackend<SystemCommandExecutor>>,
    ) -> Result<(), HelperError> {
        let peer = observed_peer(stream)?;
        let (frame, received_root) = receive_frame_with_fd(stream)?;
        duplicate_to_daemon_root_fd(received_root.as_raw_fd())?;
        let _root_fd_lease = DaemonRootFdLease;
        let root = stat_identity_fd(DAEMON_ROOT_FD)?;
        let observed_root = ObservedRootV1 {
            device_major: root.device_major,
            device_minor: root.device_minor,
            inode: root.inode,
            mount_id: root.mount_id,
        };
        let request: AuthenticatedRequestEnvelopeV1 = decode_frame(&frame)?;
        let response = engine.handle(
            &request,
            &peer,
            &observed_root,
            DAEMON_ROOT_FD,
            now_unix_ms()?,
        )?;
        write_frame(stream, &encode_frame(&response)?)
    }

    fn acquire_listener(socket_path: &Path) -> Result<UnixListener, HelperError> {
        let listen_pid = env::var("LISTEN_PID").ok().and_then(|value| value.parse::<u32>().ok());
        let listen_fds = env::var("LISTEN_FDS").ok().and_then(|value| value.parse::<u32>().ok());
        if listen_pid == Some(std::process::id()) && listen_fds == Some(1) {
            // SAFETY: systemd socket activation 把唯一监听 socket 放在 fd 3，并转移给本进程。
            return Ok(unsafe { UnixListener::from_raw_fd(3) });
        }
        if socket_path.exists() {
            return Err(HelperError::protocol("SOCKET_PATH_EXISTS"));
        }
        UnixListener::bind(socket_path).map_err(|_| HelperError::protocol("SOCKET_BIND"))
    }

    fn create_daemon_epoch(boot_id: &str, socket_path: &Path) -> Result<String, HelperError> {
        let parent = socket_path.parent().ok_or_else(|| HelperError::protocol("SOCKET_PARENT"))?;
        let sequence = monotonic_nanoseconds()?;
        let epoch = hex::encode(Sha256::digest(format!("{boot_id}:{}:{sequence}", std::process::id())));
        let destination = parent.join("daemon.epoch");
        let temporary = parent.join(format!("daemon.epoch.{}.tmp", std::process::id()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o644)
            .open(&temporary)
            .map_err(|_| HelperError::protocol("EPOCH_CREATE"))?;
        file.write_all(epoch[..32].as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| HelperError::protocol("EPOCH_WRITE"))?;
        fs::rename(&temporary, &destination).map_err(|_| HelperError::protocol("EPOCH_RENAME"))?;
        Ok(epoch[..32].to_owned())
    }

    fn parse_args(values: Vec<String>) -> Result<Args, HelperError> {
        if values.len() != 9 || values[0] != "serve-v1" || values[1] != "--socket" ||
            values[3] != "--key" || values[5] != "--provenance" || values[7] != "--public-key"
        {
            return Err(HelperError::protocol("DAEMON_ARGV"));
        }
        if values[2] != SOCKET_PATH || values[4] != KEY_PATH ||
            values[6] != PROVENANCE_PATH || values[8] != PUBLIC_KEY_PATH
        {
            return Err(HelperError::protocol("DAEMON_INSTALL_LAYOUT"));
        }
        Ok(Args {
            socket_path: canonical_absolute_path(&values[2])?,
            key_path: canonical_absolute_path(&values[4])?,
            provenance_path: canonical_absolute_path(&values[6])?,
            public_key_path: canonical_absolute_path(&values[8])?,
        })
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
        let value = fs::read_to_string(path)
            .map_err(|_| HelperError::authentication("KEY_UNREADABLE"))?;
        let value = value.trim_end_matches(['\r', '\n']);
        if value.len() != expected_bytes * 2 ||
            !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(HelperError::authentication("KEY_INVALID"));
        }
        hex::decode(value).map_err(|_| HelperError::authentication("KEY_INVALID"))
    }

    fn read_canonical_json<T: serde::de::DeserializeOwned + serde::Serialize>(path: &Path) -> Result<T, HelperError> {
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
        if value.is_empty() || value.len() > 256 {
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

    fn monotonic_nanoseconds() -> Result<u64, HelperError> {
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
