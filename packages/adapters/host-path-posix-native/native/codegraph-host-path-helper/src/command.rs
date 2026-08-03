use std::{
    collections::BTreeMap,
    io::Read,
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::protocol::HelperError;

pub const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;
const EXECUTABLE_ALLOWLIST: &[&str] = &[
    "/usr/bin/btrfs",
    "/usr/bin/mount",
    "/usr/bin/umount",
    "/usr/sbin/lvcreate",
    "/usr/sbin/lvremove",
    "/usr/sbin/lvs",
    "/usr/sbin/zfs",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    pub args: Vec<String>,
    pub executable: String,
    pub output_limit: usize,
    pub timeout_ms: u64,
}

impl CommandSpec {
    pub fn fixed(executable: &'static str, args: Vec<String>, timeout_ms: u64) -> Result<Self, HelperError> {
        if !EXECUTABLE_ALLOWLIST.contains(&executable) ||
            args.iter().any(|arg| arg.as_bytes().contains(&0)) ||
            timeout_ms == 0 ||
            timeout_ms > 60_000
        {
            return Err(HelperError::protocol("COMMAND_SPEC_INVALID"));
        }
        Ok(Self {
            args,
            executable: executable.into(),
            output_limit: COMMAND_OUTPUT_LIMIT,
            timeout_ms,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandOutput {
    pub stderr: Vec<u8>,
    pub stdout: Vec<u8>,
}

pub trait CommandExecutor {
    fn execute(&mut self, spec: &CommandSpec) -> Result<CommandOutput, HelperError>;

    /// cleanup 可重复执行；仅把固定命令的“目标已不存在”视为成功，其他失败继续 fail closed。
    fn execute_cleanup(&mut self, spec: &CommandSpec) -> Result<CommandOutput, HelperError> {
        self.execute(spec)
    }
}

pub struct SystemCommandExecutor;

impl CommandExecutor for SystemCommandExecutor {
    fn execute(&mut self, spec: &CommandSpec) -> Result<CommandOutput, HelperError> {
        let (output, success) = execute_system_command(spec)?;
        if !success {
            return Err(HelperError::snapshot("COMMAND_NONZERO", true));
        }
        Ok(output)
    }

    fn execute_cleanup(&mut self, spec: &CommandSpec) -> Result<CommandOutput, HelperError> {
        let (output, success) = execute_system_command(spec)?;
        if success || cleanup_target_is_absent(spec, &output.stderr) {
            return Ok(output);
        }
        Err(HelperError::snapshot("COMMAND_NONZERO", true))
    }
}

fn execute_system_command(spec: &CommandSpec) -> Result<(CommandOutput, bool), HelperError> {
        let mut environment = BTreeMap::new();
        environment.insert("LANG", "C");
        environment.insert("LC_ALL", "C");
        environment.insert("PATH", "/usr/sbin:/usr/bin");
        let mut child = Command::new(&spec.executable)
            .args(&spec.args)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| HelperError::snapshot("COMMAND_SPAWN_FAILED", false))?;
        // stdout/stderr 必须与进程并发 drain；先 wait 再读取会在 pipe 填满时永久阻塞。
        let stdout = child.stdout.take()
            .ok_or_else(|| terminate_child(&mut child, "COMMAND_STDOUT_PIPE"))?;
        let stderr = child.stderr.take()
            .ok_or_else(|| terminate_child(&mut child, "COMMAND_STDERR_PIPE"))?;
        let stdout_limit = spec.output_limit;
        let stderr_limit = spec.output_limit;
        let stdout_reader = thread::spawn(move || read_limited_stdout(stdout, stdout_limit));
        let stderr_reader = thread::spawn(move || read_limited_stderr(stderr, stderr_limit));
        let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(HelperError::snapshot("COMMAND_WAIT_FAILED", true));
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(HelperError::deadline("COMMAND_TIMEOUT"));
            }
            thread::sleep(Duration::from_millis(5));
        };
        let stdout = join_reader(stdout_reader, "COMMAND_STDOUT_FAILED")?;
        let stderr = join_reader(stderr_reader, "COMMAND_STDERR_FAILED")?;
        if stdout.len() > spec.output_limit || stderr.len() > spec.output_limit {
            return Err(HelperError::budget("COMMAND_OUTPUT_LIMIT"));
        }
        Ok((CommandOutput { stderr, stdout }, status.success()))
}

fn cleanup_target_is_absent(spec: &CommandSpec, stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    match (spec.executable.as_str(), spec.args.first().map(String::as_str)) {
        ("/usr/bin/umount", Some("--")) =>
            stderr.contains("not mounted") || stderr.contains("no mount point specified"),
        ("/usr/sbin/zfs", Some("destroy")) => stderr.contains("dataset does not exist"),
        ("/usr/sbin/lvremove", Some("--yes")) => stderr.contains("Failed to find logical volume"),
        ("/usr/bin/btrfs", Some("subvolume")) => stderr.contains("No such file or directory"),
        _ => false,
    }
}

fn terminate_child(child: &mut Child, code: &'static str) -> HelperError {
    let _ = child.kill();
    let _ = child.wait();
    HelperError::snapshot(code, false)
}

fn read_limited_stdout(stream: ChildStdout, limit: usize) -> std::io::Result<Vec<u8>> {
    read_limited(stream, limit)
}

fn read_limited_stderr(stream: ChildStderr, limit: usize) -> std::io::Result<Vec<u8>> {
    read_limited(stream, limit)
}

fn read_limited<R: Read>(stream: R, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    stream.take((limit + 1) as u64).read_to_end(&mut output)?;
    Ok(output)
}

fn join_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    code: &'static str,
) -> Result<Vec<u8>, HelperError> {
    reader.join()
        .map_err(|_| HelperError::snapshot(code, true))?
        .map_err(|_| HelperError::snapshot(code, true))
}

#[cfg(test)]
pub mod testing {
    use std::collections::VecDeque;

    use super::{CommandExecutor, CommandOutput, CommandSpec};
    use crate::protocol::HelperError;

    #[derive(Default)]
    pub struct FakeCommandExecutor {
        pub calls: Vec<CommandSpec>,
        pub results: VecDeque<Result<CommandOutput, HelperError>>,
    }

    impl CommandExecutor for FakeCommandExecutor {
        fn execute(&mut self, spec: &CommandSpec) -> Result<CommandOutput, HelperError> {
            self.calls.push(spec.clone());
            self.results.pop_front().unwrap_or_else(|| Ok(CommandOutput {
                stderr: Vec::new(),
                stdout: Vec::new(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandSpec, cleanup_target_is_absent};

    #[test]
    fn cleanup_only_accepts_command_specific_absent_evidence() {
        let zfs = CommandSpec::fixed(
            "/usr/sbin/zfs",
            vec!["destroy".into(), "--".into(), "tank/repo@snapshot".into()],
            1_000,
        ).expect("zfs cleanup");
        assert!(cleanup_target_is_absent(
            &zfs,
            b"cannot open 'tank/repo@snapshot': dataset does not exist",
        ));
        assert!(!cleanup_target_is_absent(&zfs, b"permission denied"));

        let mount = CommandSpec::fixed(
            "/usr/bin/umount",
            vec!["--".into(), "/run/codegraph-host-path/snapshots/view".into()],
            1_000,
        ).expect("mount cleanup");
        assert!(cleanup_target_is_absent(&mount, b"target is not mounted"));
        assert!(!cleanup_target_is_absent(&mount, b"target is busy"));
    }
}
