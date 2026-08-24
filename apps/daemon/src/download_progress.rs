//! Streaming HTTP download that reports its own progress.
//!
//! Both installers used to fetch their asset with a single `resp.bytes().await`,
//! which yields nothing at all until the last byte has landed. On a slow route
//! that is minutes of silence during the one step of first-run setup that
//! actually takes time, and the desktop wizard — which renders whatever these
//! lines say — had nothing to show but "installing…". Streaming the body lets us
//! emit byte counts as they arrive, so the wizard can draw a real progress bar.
//!
//! The emitted line is the same `{"event","message"}` JSON the installers
//! already print, with `url` / `downloaded` / `total` / `percent` added. Readers
//! that only know the old shape keep working: the message still reads
//! "downloading <url>".

use std::time::{Duration, Instant};

use futures_util::StreamExt;

/// Percent the transfer must advance before another line is worth emitting.
/// Every line crosses the sidecar pipe and becomes a Tauri event on the other
/// side, so this is real cost rather than log noise.
const MIN_PERCENT_STEP: u64 = 2;

/// Reporting step when the server sends no `Content-Length` — there is no
/// percentage to advance, so fall back to "another chunk this big arrived".
const MIN_BYTES_STEP: u64 = 512 * 1024;

/// Floor on the gap between two lines, so a fast mirror does not emit fifty of
/// them in a second.
const MIN_INTERVAL: Duration = Duration::from_millis(150);

/// Cap on the buffer we pre-allocate from a server-supplied `Content-Length`.
/// Release assets are tens of megabytes; a wrong (or hostile) header must not
/// turn into a multi-gigabyte allocation.
const MAX_PREALLOC: u64 = 128 * 1024 * 1024;

/// Decides which of the arriving chunks are worth a progress line.
struct Throttle {
    total: Option<u64>,
    last_at: Instant,
    last_bytes: u64,
    last_percent: u64,
}

impl Throttle {
    fn new(total: Option<u64>) -> Self {
        Self {
            total,
            last_at: Instant::now(),
            last_bytes: 0,
            last_percent: 0,
        }
    }

    fn should_report(&mut self, downloaded: u64) -> bool {
        let now = Instant::now();
        if now.duration_since(self.last_at) < MIN_INTERVAL {
            return false;
        }
        let enough = match self.total {
            Some(total) => {
                let percent = percent_of(downloaded, total);
                percent.saturating_sub(self.last_percent) >= MIN_PERCENT_STEP
            }
            None => downloaded.saturating_sub(self.last_bytes) >= MIN_BYTES_STEP,
        };
        if !enough {
            return false;
        }
        self.last_at = now;
        self.last_bytes = downloaded;
        self.last_percent = self.total.map(|t| percent_of(downloaded, t)).unwrap_or(0);
        true
    }
}

fn percent_of(downloaded: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    (downloaded.min(total).saturating_mul(100)) / total
}

/// Print one download line. Public so a caller that fetches bytes some other way
/// can still report in the same shape.
pub fn report(url: &str, downloaded: u64, total: Option<u64>) {
    let mut payload = serde_json::json!({
        "event": "download",
        "message": format!("downloading {url}"),
        "url": url,
        "downloaded": downloaded,
    });
    if let Some(total) = total.filter(|t| *t > 0) {
        payload["total"] = serde_json::json!(total);
        payload["percent"] = serde_json::json!(percent_of(downloaded, total));
    }
    println!("{payload}");
}

/// The client these downloads use.
///
/// `no_proxy` is deliberate for the loopback case: reqwest reads `http_proxy` /
/// `ALL_PROXY` from the environment and does *not* exempt localhost, so the
/// unit test below would have its request CONNECTed through whatever proxy the
/// machine happens to have configured and never reach its own listener. Real
/// downloads go to public hosts where a corporate proxy is not something we
/// route around, so this stays scoped to loopback.
fn client_for(url: &str) -> reqwest::Result<reqwest::Client> {
    let loopback = url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("http://[::1]");
    let builder = reqwest::Client::builder();
    if loopback {
        builder.no_proxy().build()
    } else {
        builder.build()
    }
}

/// Download `url` into memory, printing progress lines as the body arrives.
///
/// Builds its own current-thread runtime, so it is safe to call from the
/// synchronous CLI paths the installers run on (and must NOT be called from
/// inside an existing runtime).
pub fn download(url: &str) -> anyhow::Result<Vec<u8>> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            let response = client_for(url)?.get(url).send().await?.error_for_status()?;
            let total = response.content_length();
            let mut buf: Vec<u8> = match total {
                Some(n) => Vec::with_capacity(n.min(MAX_PREALLOC) as usize),
                None => Vec::new(),
            };
            let mut throttle = Throttle::new(total);
            report(url, 0, total);

            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                buf.extend_from_slice(&chunk?);
                let downloaded = buf.len() as u64;
                if throttle.should_report(downloaded) {
                    report(url, downloaded, total);
                }
            }

            // Always close on a final line: the throttle may have suppressed the
            // last chunk, and a bar frozen at 96% reads as a stall.
            report(url, buf.len() as u64, total);
            Ok(buf)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_is_clamped_to_the_total() {
        assert_eq!(percent_of(0, 100), 0);
        assert_eq!(percent_of(50, 100), 50);
        // A server that under-reports Content-Length must not produce 137%.
        assert_eq!(percent_of(137, 100), 100);
        // No total means no percentage to divide by.
        assert_eq!(percent_of(10, 0), 0);
    }

    #[test]
    fn a_sized_transfer_reports_every_few_percent_and_no_faster() {
        let mut throttle = Throttle::new(Some(1_000_000));
        throttle.last_at = Instant::now() - MIN_INTERVAL * 2;
        // Under the percent step, even with the interval satisfied.
        assert!(!throttle.should_report(10_000));
        assert!(throttle.should_report(30_000));
        // Immediately after a report the interval floor takes over.
        assert!(!throttle.should_report(500_000));
    }

    /// End-to-end over a real socket: the point of the rewrite is that the body
    /// is consumed chunk by chunk rather than in one `bytes()` await, and a
    /// streaming reader that drops or reorders a chunk would still "work" against
    /// a mock. Serves a body big enough to arrive in several chunks.
    #[test]
    fn download_reassembles_a_chunked_body_byte_for_byte() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let expected = body.clone();

        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Drain the request head first: writing a response while the request
            // is still unread resets the connection on some platforms.
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => head.push(byte[0]),
                }
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            for chunk in body.chunks(64 * 1024) {
                stream.write_all(chunk).unwrap();
                std::thread::sleep(Duration::from_millis(20));
            }
            stream.flush().unwrap();
        });

        let got = download(&format!("http://127.0.0.1:{port}/asset.bin")).unwrap();
        server.join().unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn an_unsized_transfer_falls_back_to_a_byte_step() {
        let mut throttle = Throttle::new(None);
        throttle.last_at = Instant::now() - MIN_INTERVAL * 2;
        assert!(!throttle.should_report(MIN_BYTES_STEP - 1));
        throttle.last_at = Instant::now() - MIN_INTERVAL * 2;
        assert!(throttle.should_report(MIN_BYTES_STEP));
    }
}
