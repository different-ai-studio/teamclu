//! Crash and error reporting for amuxd.
//!
//! The daemon had no error reporting at all: a panic, a failed app seed, a
//! sync loop stuck on one error only ever reached `logs/amuxd.log` on the
//! user's machine. This reports panics and `error!` events to the same Sentry
//! project as the desktop's Rust process, tagged `component=amuxd`.
//!
//! - Panics become events (sentry's panic integration, chained to any
//!   existing hook).
//! - `error!` becomes an event; `warn!` becomes a breadcrumb that rides along
//!   with the next event; everything quieter is ignored.
//! - The same error is sent at most once per [`DEDUP_WINDOW`] per process, and
//!   at most [`HOURLY_CAP`] events per hour in total, so one fault repeating
//!   in a retry loop cannot drain the org's quota.
//! - No identity: no user, no hostname, and the home directory is replaced by
//!   `~` in every message and breadcrumb (paths here routinely carry the OS
//!   user name).
//!
//! Off in debug builds unless `AMUXD_SENTRY_DEBUG=1`; `AMUXD_SENTRY=0` turns it
//! off in a release build.
//!
//! The transport is our own, on the reqwest 0.12 + rustls client the daemon
//! already ships: sentry's bundled transport needs reqwest 0.13, which would
//! add a second TLS stack (and native-tls by default) to the sidecar.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use sentry::protocol::{Breadcrumb, Event};
use sentry::{ClientOptions, Envelope, Transport};

/// The desktop Rust project (`teamclu-rust`); see apps/desktop/src/main.rs.
const SENTRY_DSN: &str =
    "https://53fd6d3ad645819bb83e0a9404750690@o60909.ingest.us.sentry.io/4512025501237248";
const DEDUP_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);
const HOURLY_CAP: usize = 20;
const QUEUE_DEPTH: usize = 32;

fn enabled() -> bool {
    if std::env::var("AMUXD_SENTRY").is_ok_and(|v| v == "0") {
        return false;
    }
    !cfg!(debug_assertions) || std::env::var("AMUXD_SENTRY_DEBUG").is_ok_and(|v| v == "1")
}

/// Initialise reporting. Keep the guard alive for the life of the process;
/// dropping it flushes queued events.
pub fn init() -> Option<sentry::ClientInitGuard> {
    if !enabled() {
        return None;
    }
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|h| h.len() > 1);
    let home_for_crumbs = home.clone();
    let limiter = Arc::new(Mutex::new(Limiter::default()));

    let guard = sentry::init(ClientOptions {
        dsn: SENTRY_DSN.parse().ok(),
        release: Some(Cow::Owned(format!("amuxd@{}", env!("CARGO_PKG_VERSION")))),
        environment: Some(Cow::Borrowed(if cfg!(debug_assertions) {
            "development"
        } else {
            "production"
        })),
        send_default_pii: false,
        // Breadcrumbs are warn-level log lines; keep the trail short.
        max_breadcrumbs: 30,
        transport: Some(Arc::new(|options: &ClientOptions| {
            Arc::new(DaemonTransport::new(options)) as Arc<dyn Transport>
        })),
        before_send: Some(Arc::new(move |event| {
            let event = scrub_event(event, home.as_deref());
            let key = dedup_key(&event);
            let allowed = limiter
                .lock()
                .map(|mut l| l.allow(&key, Instant::now()))
                .unwrap_or(false);
            allowed.then_some(event)
        })),
        before_breadcrumb: Some(Arc::new(move |mut crumb: Breadcrumb| {
            if let (Some(home), Some(message)) =
                (home_for_crumbs.as_deref(), crumb.message.as_mut())
            {
                *message = redact_home(message, home);
            }
            Some(crumb)
        })),
        ..Default::default()
    });
    sentry::configure_scope(|scope| {
        scope.set_tag("component", "amuxd");
        scope.set_tag("os.family", std::env::consts::OS);
    });
    Some(guard)
}

/// The tracing layer that turns `error!` into events and `warn!` into
/// breadcrumbs. Spans are not sent: this is not performance monitoring.
pub fn tracing_layer<S>() -> impl tracing_subscriber::Layer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    use sentry::integrations::tracing::EventFilter;
    sentry::integrations::tracing::layer()
        .event_filter(|meta| match *meta.level() {
            tracing::Level::ERROR => EventFilter::Event,
            tracing::Level::WARN => EventFilter::Breadcrumb,
            _ => EventFilter::Ignore,
        })
        .span_filter(|_| false)
}

fn redact_home(text: &str, home: &str) -> String {
    text.replace(home, "~")
}

fn scrub_event(mut event: Event<'static>, home: Option<&str>) -> Event<'static> {
    event.user = None;
    event.server_name = None;
    if let Some(home) = home {
        if let Some(message) = event.message.as_mut() {
            *message = redact_home(message, home);
        }
        if let Some(logentry) = event.logentry.as_mut() {
            logentry.message = redact_home(&logentry.message, home);
        }
        for exception in event.exception.values.iter_mut() {
            if let Some(value) = exception.value.as_mut() {
                *value = redact_home(value, home);
            }
        }
        for crumb in event.breadcrumbs.values.iter_mut() {
            if let Some(message) = crumb.message.as_mut() {
                *message = redact_home(message, home);
            }
        }
    }
    event
}

/// Same error, same key: ids, counts and other digits are dropped so a retry
/// loop logging a fresh request id every time still collapses to one key.
fn dedup_key(event: &Event<'static>) -> String {
    let text = event
        .exception
        .values
        .last()
        .and_then(|e| e.value.clone())
        .or_else(|| event.message.clone())
        .or_else(|| event.logentry.as_ref().map(|l| l.message.clone()))
        .unwrap_or_default();
    let mut key: String = text
        .split_whitespace()
        .map(|word| {
            if word.chars().any(|c| c.is_ascii_digit()) {
                "#"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect();
    if let Some(logger) = &event.logger {
        key.insert_str(0, &format!("{logger}|"));
    }
    key
}

#[derive(Default)]
struct Limiter {
    last_sent: HashMap<String, Instant>,
    hour_started: Option<Instant>,
    sent_this_hour: usize,
}

impl Limiter {
    fn allow(&mut self, key: &str, now: Instant) -> bool {
        if let Some(previous) = self.last_sent.get(key) {
            if now.saturating_duration_since(*previous) < DEDUP_WINDOW {
                return false;
            }
        }
        let hour_over = self
            .hour_started
            .is_none_or(|start| now.saturating_duration_since(start) >= Duration::from_secs(3600));
        if hour_over {
            self.hour_started = Some(now);
            self.sent_this_hour = 0;
        }
        if self.sent_this_hour >= HOURLY_CAP {
            return false;
        }
        self.sent_this_hour += 1;
        self.last_sent.insert(key.to_string(), now);
        true
    }
}

/// Sends envelopes from one background thread. Bounded: when Sentry is
/// unreachable the queue fills and further events are dropped rather than
/// held in memory.
struct DaemonTransport {
    sender: Mutex<Option<mpsc::SyncSender<Envelope>>>,
    pending: Arc<AtomicUsize>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl DaemonTransport {
    fn new(options: &ClientOptions) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Envelope>(QUEUE_DEPTH);
        let pending = Arc::new(AtomicUsize::new(0));
        let target = options.dsn.as_ref().map(|dsn| {
            (
                dsn.envelope_api_url().to_string(),
                dsn.to_auth(Some(&options.user_agent)).to_string(),
            )
        });
        let worker_pending = Arc::clone(&pending);
        let worker = std::thread::Builder::new()
            .name("sentry-transport".into())
            .spawn(move || {
                let Some((url, auth)) = target else { return };
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                let client = teamclu_gateway::http_client(Duration::from_secs(15));
                while let Ok(envelope) = receiver.recv() {
                    let mut body = Vec::new();
                    if envelope.to_writer(&mut body).is_ok() {
                        let request = client.post(&url).header("X-Sentry-Auth", &auth).body(body);
                        let _ = runtime.block_on(request.send());
                    }
                    worker_pending.fetch_sub(1, Ordering::SeqCst);
                }
            })
            .ok();
        Self {
            sender: Mutex::new(Some(sender)),
            pending,
            worker: Mutex::new(worker),
        }
    }
}

impl Transport for DaemonTransport {
    fn send_envelope(&self, envelope: Envelope) {
        let Ok(guard) = self.sender.lock() else {
            return;
        };
        let Some(sender) = guard.as_ref() else { return };
        self.pending.fetch_add(1, Ordering::SeqCst);
        if sender.try_send(envelope).is_err() {
            self.pending.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.pending.load(Ordering::SeqCst) > 0 {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    fn shutdown(&self, timeout: Duration) -> bool {
        let flushed = self.flush(timeout);
        // Closing the channel ends the worker loop.
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
        if flushed {
            if let Ok(mut worker) = self.worker.lock() {
                if let Some(handle) = worker.take() {
                    let _ = handle.join();
                }
            }
        }
        flushed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_event(message: &str) -> Event<'static> {
        Event {
            message: Some(message.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn home_dir_and_identity_are_scrubbed() {
        let mut event = message_event("open /Users/alice/.amuxd/teams/x failed");
        event.server_name = Some("alices-mac.local".into());
        event.user = Some(sentry::User {
            username: Some("alice".into()),
            ..Default::default()
        });
        let scrubbed = scrub_event(event, Some("/Users/alice"));
        assert_eq!(
            scrubbed.message.as_deref(),
            Some("open ~/.amuxd/teams/x failed")
        );
        assert!(scrubbed.server_name.is_none());
        assert!(scrubbed.user.is_none());
    }

    #[test]
    fn retry_noise_collapses_to_one_key() {
        let a = dedup_key(&message_event("request 4821 failed after 3 tries"));
        let b = dedup_key(&message_event("request 9930 failed after 5 tries"));
        assert_eq!(a, b);
        let c = dedup_key(&message_event("auth refresh failed"));
        assert_ne!(a, c);
    }

    #[test]
    fn limiter_dedups_and_caps() {
        let mut limiter = Limiter::default();
        let t0 = Instant::now();
        assert!(limiter.allow("a", t0));
        assert!(!limiter.allow("a", t0 + Duration::from_secs(60)));
        assert!(limiter.allow("a", t0 + DEDUP_WINDOW));

        let mut limiter = Limiter::default();
        for i in 0..HOURLY_CAP {
            assert!(limiter.allow(&format!("k{i}"), t0));
        }
        assert!(!limiter.allow("one-more", t0));
        assert!(limiter.allow("one-more", t0 + Duration::from_secs(3600)));
    }
}
