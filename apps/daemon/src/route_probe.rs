//! "How fast is this download actually going to be?", measured.
//!
//! Every installer in this crate has to pick between an upstream source and a
//! mirror, and each of them used to pick by *reachability*: a HEAD that
//! answered 200 meant "use upstream". From mainland China that is precisely
//! the wrong question — GitHub and registry.npmjs.org answer a HEAD in about a
//! second and then stream the payload at a trickle, so the preflight passed,
//! the mirror was never consulted, and the user watched a download crawl.
//!
//! So: sample the real bytes over the real route, and decide on the number.

use std::time::{Duration, Instant};

/// What a route delivered while being sampled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RouteSample {
    pub bytes: u64,
    pub elapsed: Duration,
}

impl RouteSample {
    pub fn bytes_per_sec(&self) -> f64 {
        // Floor the divisor: a sample that arrived inside a clock tick would
        // otherwise divide by zero.
        self.bytes as f64 / self.elapsed.as_secs_f64().max(0.001)
    }

    pub fn mib_per_sec(&self) -> f64 {
        self.bytes_per_sec() / (1024.0 * 1024.0)
    }

    /// Does this route clear `probe`'s bar?
    ///
    /// A short sample is a failure however fast those bytes arrived: it means
    /// the transfer died early, which is not a route worth handing a large
    /// download to.
    pub fn meets(&self, probe: &Probe) -> bool {
        self.bytes >= probe.min_sample && self.bytes_per_sec() >= probe.min_bytes_per_sec
    }
}

/// How to sample one route, and the bar it has to clear.
#[derive(Debug, Clone, Copy)]
pub struct Probe {
    /// How much of the real payload to pull.
    ///
    /// Size this against the payload, and against the initial burst: the first
    /// half-megabyte arrives out of a server-side buffer and a grown receive
    /// window, and measured 10 MB/s on a route whose sustained rate was
    /// 3 MB/s. Sampling past the burst is what makes the number mean anything.
    pub bytes: u64,
    /// Below this, the sample says more about handshake jitter than the route.
    pub min_sample: u64,
    pub connect_timeout: Duration,
    /// Hard stop for the transfer, measured from the first byte. A route that
    /// cannot deliver `bytes` inside this window is already far below any
    /// useful bar, so there is nothing to learn by waiting longer.
    pub transfer_deadline: Duration,
    pub min_bytes_per_sec: f64,
}

impl Probe {
    /// Measure `url` by ranged GET of its first `self.bytes` bytes.
    ///
    /// `None` means the route failed outright — blocked, DNS, TLS, non-2xx —
    /// which is the same signal the old reachability preflights gave.
    pub fn measure(&self, url: &str) -> Option<RouteSample> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        runtime.block_on(async {
            let client = reqwest::Client::builder()
                .connect_timeout(self.connect_timeout)
                .timeout(self.connect_timeout + self.transfer_deadline)
                .build()
                .ok()?;
            let mut response = client
                .get(url)
                .header(
                    reqwest::header::RANGE,
                    format!("bytes=0-{}", self.bytes.saturating_sub(1)),
                )
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?;
            // The clock starts at the first byte: a slow handshake must not
            // read as a slow pipe, and a fast handshake must not hide one. A
            // server that ignores Range simply gets cut off at `bytes`.
            let started = Instant::now();
            let mut bytes = 0u64;
            while let Ok(Some(chunk)) = response.chunk().await {
                bytes += chunk.len() as u64;
                if bytes >= self.bytes || started.elapsed() >= self.transfer_deadline {
                    break;
                }
            }
            Some(RouteSample {
                bytes,
                elapsed: started.elapsed(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(min_bytes_per_sec: f64) -> Probe {
        Probe {
            bytes: 2 * 1024 * 1024,
            min_sample: 64 * 1024,
            connect_timeout: Duration::from_secs(5),
            transfer_deadline: Duration::from_secs(4),
            min_bytes_per_sec,
        }
    }

    fn sample(bytes: u64, millis: u64) -> RouteSample {
        RouteSample {
            bytes,
            elapsed: Duration::from_millis(millis),
        }
    }

    #[test]
    fn a_slow_route_misses_the_bar() {
        // The regression this exists for: the endpoint answers, then trickles.
        // 2 MiB in 4s is ~512 KB/s.
        let slow = sample(2 * 1024 * 1024, 4_000);
        assert!(!slow.meets(&probe(1024.0 * 1024.0)));
        assert!(slow.mib_per_sec() < 1.0);
    }

    #[test]
    fn a_fast_route_clears_it() {
        assert!(sample(2 * 1024 * 1024, 200).meets(&probe(1024.0 * 1024.0)));
    }

    #[test]
    fn the_bar_is_exactly_the_configured_rate() {
        // Straddle it from both sides so a threshold change has to be
        // deliberate.
        assert!(sample(1024 * 1024, 1_000).meets(&probe(1024.0 * 1024.0)));
        assert!(!sample(1024 * 1024, 1_100).meets(&probe(1024.0 * 1024.0)));
    }

    #[test]
    fn a_truncated_sample_is_not_a_verdict() {
        // A transfer that died after 8 KiB says nothing useful, however fast
        // those bytes arrived.
        let truncated = sample(8 * 1024, 1);
        assert!(truncated.bytes_per_sec() > 1024.0 * 1024.0);
        assert!(!truncated.meets(&probe(1024.0 * 1024.0)));
    }

    #[test]
    fn an_instant_sample_does_not_divide_by_zero() {
        let instant = sample(2 * 1024 * 1024, 0);
        assert!(instant.bytes_per_sec().is_finite());
        assert!(instant.meets(&probe(1024.0 * 1024.0)));
    }
}
