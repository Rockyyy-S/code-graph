#[cfg(unix)]
mod unix {
    use std::{
        fs,
        io::{Read, Write},
        mem::{MaybeUninit, size_of},
        os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        os::unix::fs::MetadataExt,
        os::unix::net::UnixStream,
    };

    use crate::{
        canonical::MAX_FRAME_BYTES,
        protocol::HelperError,
        security::ObservedPeerV1,
    };

    pub const DAEMON_ROOT_FD: RawFd = 9;

    pub fn send_frame_with_fd(
        stream: &mut UnixStream,
        frame: &[u8],
        fd: RawFd,
    ) -> Result<(), HelperError> {
        if frame.len() < 5 || frame.len() > MAX_FRAME_BYTES + 4 || fd < 0 {
            return Err(HelperError::protocol("SCM_SEND_SHAPE"));
        }
        let mut iov = libc::iovec {
            iov_base: frame.as_ptr().cast_mut().cast(),
            iov_len: frame.len(),
        };
        let control_len = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) as usize };
        let mut control = vec![0u8; control_len];
        let mut message = unsafe { MaybeUninit::<libc::msghdr>::zeroed().assume_init() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control.len();
        // SAFETY: message 的 control buffer 足够容纳一个 SCM_RIGHTS fd。
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            if header.is_null() {
                return Err(HelperError::protocol("SCM_HEADER"));
            }
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as usize;
            std::ptr::copy_nonoverlapping(
                (&fd as *const RawFd).cast::<u8>(),
                libc::CMSG_DATA(header),
                size_of::<RawFd>(),
            );
        }
        // SAFETY: msghdr、iov 与 control 在调用期间均有效。
        let written = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
        if written < 0 {
            return Err(HelperError::protocol("SCM_SEND_FAILED"));
        }
        let written = written as usize;
        if written < frame.len() {
            stream.write_all(&frame[written..])
                .map_err(|_| HelperError::protocol("SCM_SEND_PARTIAL"))?;
        }
        Ok(())
    }

    pub fn receive_frame_with_fd(stream: &mut UnixStream) -> Result<(Vec<u8>, OwnedFd), HelperError> {
        let mut first = vec![0u8; 64 * 1024];
        let mut iov = libc::iovec {
            iov_base: first.as_mut_ptr().cast(),
            iov_len: first.len(),
        };
        let control_len = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) as usize };
        let mut control = vec![0u8; control_len];
        let mut message = unsafe { MaybeUninit::<libc::msghdr>::zeroed().assume_init() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control.len();
        // SAFETY: msghdr、iov 与 control 在调用期间均有效。
        let received = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
        if received <= 0 || message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0 {
            return Err(HelperError::protocol("SCM_RECEIVE_FAILED"));
        }
        let mut received_fds = Vec::new();
        // SAFETY: cmsg 遍历受内核返回的 msg_controllen 约束。
        unsafe {
            let mut header = libc::CMSG_FIRSTHDR(&message);
            while !header.is_null() {
                if (*header).cmsg_level == libc::SOL_SOCKET && (*header).cmsg_type == libc::SCM_RIGHTS {
                    let base = libc::CMSG_LEN(0) as usize;
                    let length = (*header).cmsg_len;
                    if length < base || (length - base) % size_of::<RawFd>() != 0 {
                        close_received_fds(&received_fds);
                        return Err(HelperError::protocol("SCM_RIGHTS_LENGTH"));
                    }
                    let count = (length - base) / size_of::<RawFd>();
                    for index in 0..count {
                        let mut fd = -1;
                        std::ptr::copy_nonoverlapping(
                            libc::CMSG_DATA(header).add(index * size_of::<RawFd>()),
                            (&mut fd as *mut RawFd).cast::<u8>(),
                            size_of::<RawFd>(),
                        );
                        received_fds.push(fd);
                    }
                } else {
                    close_received_fds(&received_fds);
                    return Err(HelperError::protocol("SCM_CONTROL_UNEXPECTED"));
                }
                header = libc::CMSG_NXTHDR(&message, header);
            }
        }
        if received_fds.len() != 1 {
            close_received_fds(&received_fds);
            return Err(if received_fds.is_empty() {
                HelperError::authentication("ROOT_FD_MISSING")
            } else {
                HelperError::protocol("SCM_MULTIPLE_FDS")
            });
        }
        let received_fd = received_fds[0];
        first.truncate(received as usize);
        while first.len() < 4 {
            let mut byte = [0u8; 4];
            let count = stream.read(&mut byte[..4 - first.len()])
                .map_err(|_| HelperError::protocol("FRAME_PREFIX_READ"))?;
            if count == 0 {
                // SAFETY: fd 来自 SCM_RIGHTS 且尚未转移所有权。
                unsafe { libc::close(received_fd) };
                return Err(HelperError::protocol("FRAME_PREFIX_EOF"));
            }
            first.extend_from_slice(&byte[..count]);
        }
        let declared = u32::from_be_bytes(first[..4].try_into().expect("prefix")) as usize;
        if declared == 0 || declared > MAX_FRAME_BYTES {
            // SAFETY: fd 来自 SCM_RIGHTS 且尚未转移所有权。
            unsafe { libc::close(received_fd) };
            return Err(HelperError::budget("FRAME_SIZE"));
        }
        let total = declared + 4;
        if first.len() > total {
            // SAFETY: fd 来自 SCM_RIGHTS 且尚未转移所有权。
            unsafe { libc::close(received_fd) };
            return Err(HelperError::protocol("FRAME_TRAILING_BYTES"));
        }
        let buffered = first.len();
        first.resize(total, 0);
        stream.read_exact(&mut first[buffered..])
            .map_err(|_| HelperError::protocol("FRAME_BODY_READ"))?;
        // SAFETY: fd 是接收方新获得且唯一拥有的描述符。
        Ok((first, unsafe { OwnedFd::from_raw_fd(received_fd) }))
    }

    fn close_received_fds(fds: &[RawFd]) {
        for fd in fds {
            // SAFETY: 这些 fd 来自 SCM_RIGHTS，错误路径尚未转移所有权。
            unsafe { libc::close(*fd) };
        }
    }

    pub fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, HelperError> {
        let mut prefix = [0u8; 4];
        reader.read_exact(&mut prefix).map_err(|_| HelperError::protocol("FRAME_PREFIX_READ"))?;
        let length = u32::from_be_bytes(prefix) as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(HelperError::budget("FRAME_SIZE"));
        }
        let mut frame = Vec::with_capacity(length + 4);
        frame.extend_from_slice(&prefix);
        frame.resize(length + 4, 0);
        reader.read_exact(&mut frame[4..]).map_err(|_| HelperError::protocol("FRAME_BODY_READ"))?;
        Ok(frame)
    }

    pub fn write_frame<W: Write>(writer: &mut W, frame: &[u8]) -> Result<(), HelperError> {
        writer.write_all(frame).map_err(|_| HelperError::protocol("FRAME_WRITE"))
    }

    pub fn observed_peer(stream: &UnixStream) -> Result<ObservedPeerV1, HelperError> {
        let mut credentials = MaybeUninit::<libc::ucred>::zeroed();
        let mut length = size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: credentials 指向足够的可写 ucred，length 精确。
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                credentials.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if result != 0 || length as usize != size_of::<libc::ucred>() {
            return Err(HelperError::authentication("PEER_CREDENTIALS"));
        }
        // SAFETY: getsockopt 成功并返回完整 ucred。
        let credentials = unsafe { credentials.assume_init() };
        let pid = u32::try_from(credentials.pid)
            .map_err(|_| HelperError::authentication("PEER_PID"))?;
        Ok(ObservedPeerV1 {
            gid: credentials.gid,
            mount_namespace_inode: namespace_inode(pid)?,
            pid,
            start_time_ticks: process_start_time_ticks(pid)?,
            uid: credentials.uid,
        })
    }

    pub fn self_peer() -> Result<ObservedPeerV1, HelperError> {
        // SAFETY: libc 身份查询无前置条件。
        let pid = unsafe { libc::getpid() } as u32;
        Ok(ObservedPeerV1 {
            // SAFETY: libc 身份查询无前置条件。
            gid: unsafe { libc::getgid() },
            mount_namespace_inode: namespace_inode(pid)?,
            pid,
            start_time_ticks: process_start_time_ticks(pid)?,
            // SAFETY: libc 身份查询无前置条件。
            uid: unsafe { libc::getuid() },
        })
    }

    pub fn duplicate_to_daemon_root_fd(fd: RawFd) -> Result<(), HelperError> {
        if fd == DAEMON_ROOT_FD {
            return Ok(());
        }
        // SAFETY: dup2 只复制有效接收 fd 到固定 helper-owned slot。
        if unsafe { libc::dup2(fd, DAEMON_ROOT_FD) } < 0 {
            return Err(HelperError::authentication("ROOT_FD_DUP"));
        }
        // 子命令必须继承 slot 9，显式清除 CLOEXEC。
        // SAFETY: 固定 fd 9 已由 dup2 成功创建。
        if unsafe { libc::fcntl(DAEMON_ROOT_FD, libc::F_SETFD, 0) } < 0 {
            return Err(HelperError::authentication("ROOT_FD_FLAGS"));
        }
        Ok(())
    }

    pub fn namespace_inode(pid: u32) -> Result<u64, HelperError> {
        fs::metadata(format!("/proc/{pid}/ns/mnt"))
            .map(|metadata| metadata.ino())
            .map_err(|_| HelperError::namespace("MOUNT_NAMESPACE_UNREADABLE"))
    }

    pub fn process_start_time_ticks(pid: u32) -> Result<u64, HelperError> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_err(|_| HelperError::authentication("PEER_START_TIME_UNREADABLE"))?;
        let end = stat.rfind(") ").ok_or_else(|| HelperError::authentication("PEER_STAT_INVALID"))?;
        stat[end + 2..]
            .split_whitespace()
            .nth(19)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| HelperError::authentication("PEER_START_TIME_INVALID"))
    }

    #[cfg(test)]
    mod tests {
        use std::{
            fs::File,
            io::Write,
            mem::{MaybeUninit, size_of},
            os::fd::{AsRawFd, RawFd},
            os::unix::fs::MetadataExt,
            os::unix::net::UnixStream,
            thread,
        };

        use tempfile::tempdir;

        use super::{receive_frame_with_fd, send_frame_with_fd};
        use crate::canonical::encode_frame;

        fn send_fragment_with_fd(stream: &UnixStream, fragment: &[u8], fd: RawFd) {
            let mut iov = libc::iovec {
                iov_base: fragment.as_ptr().cast_mut().cast(),
                iov_len: fragment.len(),
            };
            let control_len = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) as usize };
            let mut control = vec![0u8; control_len];
            let mut message = unsafe { MaybeUninit::<libc::msghdr>::zeroed().assume_init() };
            message.msg_iov = &mut iov;
            message.msg_iovlen = 1;
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = control.len();
            // SAFETY: 测试构造一个只含单个 SCM_RIGHTS fd 的合法 control message。
            unsafe {
                let header = libc::CMSG_FIRSTHDR(&message);
                assert!(!header.is_null());
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as usize;
                std::ptr::copy_nonoverlapping(
                    (&fd as *const RawFd).cast::<u8>(),
                    libc::CMSG_DATA(header),
                    size_of::<RawFd>(),
                );
                assert_eq!(
                    libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL),
                    fragment.len() as isize,
                );
            }
        }

        #[test]
        fn scm_rights_transfers_the_real_root_fd() {
            let root = tempdir().expect("root");
            let file = File::open(root.path()).expect("fd");
            let (mut left, mut right) = UnixStream::pair().expect("pair");
            let frame = encode_frame(&serde_json::json!({"requestId":"r1"})).expect("frame");
            send_frame_with_fd(&mut left, &frame, file.as_raw_fd()).expect("send");
            let (received_frame, received_fd) = receive_frame_with_fd(&mut right).expect("receive");
            assert_eq!(received_frame, frame);
            assert_eq!(
                std::fs::metadata(format!("/proc/self/fd/{}", received_fd.as_raw_fd()))
                    .expect("received metadata").ino(),
                std::fs::metadata(root.path()).expect("root metadata").ino(),
            );
        }

        #[test]
        fn scm_rights_preserves_a_fragmented_length_prefix() {
            let root = tempdir().expect("root");
            let file = File::open(root.path()).expect("fd");
            let (mut left, mut right) = UnixStream::pair().expect("pair");
            let frame = encode_frame(&serde_json::json!({"requestId":"fragmented"})).expect("frame");
            let first = frame[..2].to_vec();
            let remaining = frame[2..].to_vec();
            let sender = thread::spawn(move || {
                send_fragment_with_fd(&left, &first, file.as_raw_fd());
                left.write_all(&remaining).expect("remaining frame");
            });
            let (received_frame, _) = receive_frame_with_fd(&mut right).expect("receive");
            sender.join().expect("sender");
            assert_eq!(received_frame, frame);
        }
    }
}

#[cfg(unix)]
pub use unix::*;

#[cfg(not(unix))]
pub fn unsupported_transport() -> Result<(), crate::protocol::HelperError> {
    Err(crate::protocol::HelperError::unsupported("UNIX_SOCKET_REQUIRED"))
}
