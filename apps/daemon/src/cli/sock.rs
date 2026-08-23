//! One-line request / one-line reply over the amuxd control socket.
//!
//! Shared by the CLI-side stdio bridges (`remote-tools-mcp`, the cursor
//! permission hook). It used to live in `cli::mcp_server`, which was the
//! `amuxd-send` server — that server is retired (its `send` tool is now
//! `send_channel_message`'s `reply_token` branch in `teamclu-introspect`), but
//! the transport it carried is still used.

use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// Read timeout is bounded so a stalled daemon can't hang the agent.
pub(crate) fn sock_roundtrip(sock_path: &Path, line: &str) -> std::io::Result<String> {
    sock_roundtrip_with_read_timeout(sock_path, line, Duration::from_secs(30))
}

pub(crate) fn sock_roundtrip_with_read_timeout(
    sock_path: &Path,
    line: &str,
    read_timeout: Duration,
) -> std::io::Result<String> {
    #[cfg(unix)]
    let mut stream = {
        let s = UnixStream::connect(sock_path)?;
        s.set_read_timeout(Some(read_timeout))?;
        s.set_write_timeout(Some(Duration::from_secs(10)))?;
        s
    };
    // Windows: byte-mode pipe client. File-based pipe handles have no
    // read/write timeouts; the daemon always answers a roundtrip command
    // with one line (or closes), which bounds the blocking read in practice.
    #[cfg(windows)]
    let mut stream = crate::cli::process::connect_control(sock_path)?;
    stream.write_all(line.as_bytes())?;
    if !line.ends_with('\n') {
        stream.write_all(b"\n")?;
    }
    stream.flush()?;

    // Read until newline. We can't use BufReader::read_line here because we
    // need to operate on the raw stream so the writer half stays alive for
    // the daemon to write its reply.
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
            }
            Err(e) => return Err(e),
        }
    }
    String::from_utf8(buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
