//! Bounded in-memory ring buffer of recent log entries from both the Rust
//! side (via the `log` crate) and the webview JS side (via the `push_log`
//! Tauri command). Designed to be queried by the `query_logs` MCP tool so
//! an LLM can inspect what the app is doing without flooding its context.
//!
//! Entries carry a monotonic `id` so callers can paginate with `since_id`
//! to follow logs incrementally. The buffer is bounded (default 5000) and
//! oldest entries are dropped when full — the `dropped_total` counter lets
//! callers detect gaps.

use log::{Level, Log, Metadata, Record};
use parking_lot::{Mutex, MutexGuard};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_CAPACITY: usize = 5000;
/// Per-entry message length cap to keep memory bounded even with chatty logs.
const MAX_MESSAGE_LEN: usize = 8192;
/// Coalesce consecutive identical (level+source+message) entries within this
/// window into a single entry with a `repeat` counter. Protects the buffer
/// from React render-loop / polling-callback log floods that would otherwise
/// evict useful older entries.
const COALESCE_WINDOW_MS: u64 = 1000;
/// Cap on a single coalesce run: after this many repeats a new entry is
/// started, so `since_id`-cursor consumers observe progress while a message
/// keeps repeating.
const MAX_COALESCE_REPEATS: u32 = 100;
/// Cap on how long a single coalesce run may span (measured from the first
/// occurrence in the run). After this, a new entry is started.
const MAX_COALESCE_RUN_MS: u64 = 5000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    Rust,
    Js,
    /// Sentinel entry inserted by `log_mark` so an agent can bracket an
    /// action and later query the entries between begin/end markers.
    Marker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct LogEntry {
    pub id: u64,
    /// Milliseconds since UNIX epoch.
    pub ts: u64,
    /// "trace" | "debug" | "info" | "warn" | "error"
    pub level: String,
    pub source: LogSource,
    /// Module path (Rust) or window label / URL (JS), best-effort.
    pub target: Option<String>,
    pub message: String,
    /// If >1, this entry represents N consecutive identical messages
    /// coalesced into one. The `ts` is the timestamp of the first
    /// occurrence; the latest is `ts + (repeat-1) * COALESCE_WINDOW_MS` max.
    #[serde(skip_serializing_if = "is_one", default = "default_repeat")]
    pub repeat: u32,
    /// True when the entry is this plugin's own instrumentation (socket
    /// command tracing, JS bridge logs). Hidden from queries by default so
    /// the app's own logs aren't buried under MCP plumbing.
    #[serde(skip_serializing_if = "is_false", default)]
    pub plugin: bool,
    /// Timestamp (ms since epoch) of the first occurrence in this entry's
    /// coalesce run. Internal bookkeeping for capping run length; not
    /// serialized.
    #[serde(skip)]
    first_ts: u64,
}

fn is_one(n: &u32) -> bool {
    *n == 1
}
fn default_repeat() -> u32 {
    1
}
fn is_false(b: &bool) -> bool {
    !*b
}

/// Cap a log line on a UTF-8 character boundary. Byte-index slicing panics
/// when `MAX_MESSAGE_LEN` lands inside a multibyte char (typical for CJK).
fn truncate_message(message: String) -> String {
    if message.len() <= MAX_MESSAGE_LEN {
        return message;
    }
    let mut end = MAX_MESSAGE_LEN;
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &message[..end])
}

/// Detect the plugin's own instrumentation: Rust logs from this crate's
/// modules (all prefixed "[TAURI_MCP]") and the JS bridge's console output
/// (prefixed "TAURI-PLUGIN-MCP").
fn is_plugin_chatter(target: Option<&str>, message: &str) -> bool {
    target.is_some_and(|t| t.starts_with("tauri_plugin_mcp"))
        || message.contains("[TAURI_MCP]")
        || message.contains("TAURI-PLUGIN-MCP")
}

pub struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
    capacity: usize,
    next_id: AtomicU64,
    dropped_total: AtomicU64,
    /// Action markers, tracked separately from the ring so eviction can't
    /// drop a BEGIN sentinel while its END is still pending. Each entry is
    /// (log_entry_id, tag). Bounded to MARKERS_CAPACITY (oldest dropped).
    markers: Mutex<VecDeque<(u64, String)>>,
}

const MARKERS_CAPACITY: usize = 1024;

impl LogBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
            next_id: AtomicU64::new(1),
            dropped_total: AtomicU64::new(0),
            markers: Mutex::new(VecDeque::with_capacity(MARKERS_CAPACITY)),
        }
    }

    /// Insert a marker sentinel into the buffer with the given tag.
    /// Returns the log entry id of the marker (useful for direct cursor use).
    pub fn mark(&self, tag: &str, note: Option<&str>) -> u64 {
        let message = match note {
            Some(n) if !n.is_empty() => format!("[mark:{}] {}", tag, n),
            _ => format!("[mark:{}]", tag),
        };
        // Markers are never coalesced, so `push` always returns a fresh id
        // here. Using the returned id (instead of re-deriving it from
        // `next_id`) avoids racing with concurrent pushes.
        let id = self.push(
            "info",
            LogSource::Marker,
            Some(tag.to_string()),
            message,
        );
        let mut m = self.markers_lock();
        if m.len() >= MARKERS_CAPACITY {
            m.pop_front();
        }
        m.push_back((id, tag.to_string()));
        id
    }

    /// Number of markers recorded with this tag (for begin/end pairing hints).
    pub fn marker_count(&self, tag: &str) -> usize {
        self.markers_lock().iter().filter(|(_, t)| t == tag).count()
    }

    /// Look up the (begin_id, end_id_or_now) bounds for a `between` query.
    /// Returns the two most recent markers with the matching tag. If only
    /// one exists, the upper bound is the current high-water mark (so the
    /// agent can query mid-action without an explicit END marker).
    fn resolve_between(&self, tag: &str) -> Option<(u64, u64)> {
        let m = self.markers_lock();
        let mut matches: Vec<u64> = m
            .iter()
            .filter(|(_, t)| t == tag)
            .map(|(id, _)| *id)
            .collect();
        if matches.is_empty() {
            return None;
        }
        // Two most recent: take last 2 in insertion order.
        let end = matches.pop().unwrap();
        if let Some(begin) = matches.pop() {
            Some((begin, end))
        } else {
            // Only one marker — treat it as BEGIN, end *just past* HWM so the
            // exclusive `id < end` filter still includes the latest entry.
            let hwm_plus = self.next_id.load(Ordering::Relaxed);
            Some((end, hwm_plus))
        }
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<LogEntry>> {
        self.entries.lock()
    }

    fn markers_lock(&self) -> MutexGuard<'_, VecDeque<(u64, String)>> {
        self.markers.lock()
    }

    /// Push an entry into the buffer. Returns the id of the entry the
    /// message landed in — either a freshly assigned id, or the id of the
    /// existing entry when the message was coalesced into it.
    pub fn push(&self, level: &str, source: LogSource, target: Option<String>, message: String) -> u64 {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let message = truncate_message(message);

        let mut guard = self.lock();

        // Coalesce: if the most recent entry is the same level+source+message
        // within COALESCE_WINDOW_MS, just bump its repeat counter and refresh ts.
        // Marker entries are never coalesced — each mark is meaningful.
        // A run is capped (MAX_COALESCE_REPEATS repeats or MAX_COALESCE_RUN_MS
        // from its first occurrence) so `since_id`-cursor consumers still
        // observe new ids while a message keeps repeating.
        if !matches!(source, LogSource::Marker)
            && let Some(last) = guard.back_mut()
                && last.level == level
                    && last.source == source
                    && last.message == message
                    && last.target.as_deref() == target.as_deref()
                    && ts.saturating_sub(last.ts) <= COALESCE_WINDOW_MS
                    && last.repeat < MAX_COALESCE_REPEATS
                    && ts.saturating_sub(last.first_ts) <= MAX_COALESCE_RUN_MS
                {
                    last.repeat = last.repeat.saturating_add(1);
                    last.ts = ts;
                    return last.id;
                }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let plugin = !matches!(source, LogSource::Marker)
            && is_plugin_chatter(target.as_deref(), &message);
        let entry = LogEntry {
            id,
            ts,
            level: level.to_string(),
            source,
            target,
            message,
            repeat: 1,
            first_ts: ts,
            plugin,
        };

        if guard.len() >= self.capacity {
            guard.pop_front();
            self.dropped_total.fetch_add(1, Ordering::Relaxed);
        }
        guard.push_back(entry);
        id
    }

    /// Public convenience for hosts that want to forward their existing
    /// Rust logger into the ring buffer (e.g. as a `fern::Output::call`
    /// chained into `tauri-plugin-log`'s dispatch).
    pub fn push_rust(level: log::Level, target: &str, message: impl Into<String>) {
        let level_str = match level {
            log::Level::Error => "error",
            log::Level::Warn => "warn",
            log::Level::Info => "info",
            log::Level::Debug => "debug",
            log::Level::Trace => "trace",
        };
        let target = if target.is_empty() {
            None
        } else {
            Some(target.to_string())
        };
        global().push(level_str, LogSource::Rust, target, message.into());
    }

    /// Returns a snapshot of entries matching the query, plus diagnostics.
    pub fn query(&self, q: &LogQuery) -> LogQueryResult {
        // If `between` is set, resolve it into id bounds *before* taking the
        // entries lock to avoid holding two locks at once.
        let between_bounds = q
            .between
            .as_deref()
            .map(|tag| (tag.to_string(), self.resolve_between(tag)));

        let guard = self.lock();

        let level_filter = q.level.as_deref().and_then(parse_level_threshold);
        let lc_contains = q.contains.as_ref().map(|s| s.to_lowercase());
        let include_markers = q.include_markers.unwrap_or(false);
        let include_plugin = q.include_plugin.unwrap_or(false);

        // If `between` was requested but no markers exist, return empty with
        // a hint in the diagnostics.
        let (between_lower, between_upper, between_missing) = match &between_bounds {
            Some((_, Some((b, e)))) => (Some(*b), Some(*e), false),
            Some((_, None)) => (None, None, true),
            None => (None, None, false),
        };

        // If `between` was requested but markers are missing, short-circuit.
        if between_missing {
            return LogQueryResult {
                entries: vec![],
                total_matched: 0,
                buffer_size: guard.len(),
                buffer_capacity: self.capacity,
                dropped_total: self.dropped_total.load(Ordering::Relaxed),
                next_cursor: None,
                counts: count_entries(&guard),
                between_bounds: None,
            };
        }

        // Pre-filter into a Vec we can slice/limit.
        let mut filtered: Vec<&LogEntry> = guard
            .iter()
            .filter(|e| {
                // Hide marker sentinels from regular output unless explicitly asked.
                if !include_markers && matches!(e.source, LogSource::Marker) {
                    return false;
                }
                // Hide the plugin's own instrumentation unless explicitly asked.
                if !include_plugin && e.plugin {
                    return false;
                }
                if let Some(b) = between_lower
                    && e.id <= b {
                        return false;
                    }
                if let Some(u) = between_upper
                    && e.id >= u {
                        return false;
                    }
                if let Some(since_id) = q.since_id
                    && e.id <= since_id {
                        return false;
                    }
                if let Some(since_ms) = q.since_ms
                    && e.ts < since_ms {
                        return false;
                    }
                if let Some(source) = &q.source
                    && &e.source != source {
                        return false;
                    }
                if let Some(min) = level_filter {
                    let e_level = parse_level(&e.level).unwrap_or(Level::Info);
                    // log::Level: Error=1 (most severe) .. Trace=5
                    if (e_level as usize) > (min as usize) {
                        return false;
                    }
                }
                if let Some(needle) = &lc_contains
                    && !e.message.to_lowercase().contains(needle) {
                        return false;
                    }
                true
            })
            .collect();

        let total_matched = filtered.len();
        let limit = q.limit.unwrap_or(100).clamp(1, 1000);

        // Default behavior: tail (most recent N). If `head=true`, take oldest N.
        let entries: Vec<LogEntry> = if q.head.unwrap_or(false) {
            filtered.iter().take(limit).map(|e| (*e).clone()).collect()
        } else {
            let start = filtered.len().saturating_sub(limit);
            filtered.drain(start..).cloned().collect()
        };

        let next_cursor = entries.last().map(|e| e.id);

        LogQueryResult {
            entries,
            total_matched,
            buffer_size: guard.len(),
            buffer_capacity: self.capacity,
            dropped_total: self.dropped_total.load(Ordering::Relaxed),
            next_cursor,
            counts: count_entries(&guard),
            between_bounds: between_lower
                .zip(between_upper)
                .map(|(b, e)| BetweenBounds { begin: b, end: e }),
        }
    }
}

fn count_entries(entries: &VecDeque<LogEntry>) -> LogCounts {
    let (mut errors, mut warns, mut infos, mut debugs, mut traces) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut rust_count, mut js_count, mut marker_count, mut plugin_count) = (0u64, 0u64, 0u64, 0u64);
    for e in entries.iter() {
        match e.level.as_str() {
            "error" => errors += 1,
            "warn" => warns += 1,
            "info" => infos += 1,
            "debug" => debugs += 1,
            "trace" => traces += 1,
            _ => {}
        }
        match e.source {
            LogSource::Rust => rust_count += 1,
            LogSource::Js => js_count += 1,
            LogSource::Marker => marker_count += 1,
        }
        if e.plugin {
            plugin_count += 1;
        }
    }
    LogCounts {
        error: errors,
        warn: warns,
        info: infos,
        debug: debugs,
        trace: traces,
        rust: rust_count,
        js: js_count,
        marker: marker_count,
        plugin: plugin_count,
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub level: Option<String>,
    pub source: Option<LogSource>,
    pub since_id: Option<u64>,
    pub since_ms: Option<u64>,
    pub contains: Option<String>,
    pub limit: Option<usize>,
    pub head: Option<bool>,
    /// Marker tag — return only entries between the two most recent markers
    /// with this tag. If only one marker exists, the upper bound is "now".
    pub between: Option<String>,
    /// Include `LogSource::Marker` sentinel entries in the result. Default false.
    pub include_markers: Option<bool>,
    /// Include the plugin's own instrumentation entries. Default false.
    pub include_plugin: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct BetweenBounds {
    pub begin: u64,
    pub end: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQueryResult {
    pub entries: Vec<LogEntry>,
    pub total_matched: usize,
    pub buffer_size: usize,
    pub buffer_capacity: usize,
    pub dropped_total: u64,
    pub next_cursor: Option<u64>,
    pub counts: LogCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub between_bounds: Option<BetweenBounds>,
}

#[derive(Debug, Serialize)]
#[non_exhaustive]
pub struct LogCounts {
    pub error: u64,
    pub warn: u64,
    pub info: u64,
    pub debug: u64,
    pub trace: u64,
    pub rust: u64,
    pub js: u64,
    pub marker: u64,
    /// Plugin-internal entries in the buffer (hidden from queries by default).
    pub plugin: u64,
}

fn parse_level(s: &str) -> Option<Level> {
    match s.to_ascii_lowercase().as_str() {
        "error" => Some(Level::Error),
        "warn" | "warning" => Some(Level::Warn),
        "info" => Some(Level::Info),
        "debug" => Some(Level::Debug),
        "trace" => Some(Level::Trace),
        _ => None,
    }
}

/// Returns the minimum severity to *include* (e.g. "warn" => warn + error only).
fn parse_level_threshold(s: &str) -> Option<Level> {
    parse_level(s)
}

static BUFFER: OnceLock<LogBuffer> = OnceLock::new();

pub fn global() -> &'static LogBuffer {
    BUFFER.get_or_init(|| LogBuffer::new(DEFAULT_CAPACITY))
}

/// Logger adapter that copies every record into the ring buffer and then
/// forwards to a previously-installed delegate (so the host app's logging
/// keeps working). If no delegate was active, records still land in the
/// buffer but are not re-emitted to stderr/files — install this *after*
/// your existing logger.
struct BufferLogger {
    delegate: Option<Box<dyn Log>>,
}

impl Log for BufferLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        // We always want to capture into the buffer; respect the delegate's
        // filter only for re-emission, not for capture.
        self.delegate
            .as_ref()
            .map(|d| d.enabled(metadata))
            .unwrap_or(true)
    }

    fn log(&self, record: &Record) {
        let level = match record.level() {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
            Level::Trace => "trace",
        };
        let target = if record.target().is_empty() {
            None
        } else {
            Some(record.target().to_string())
        };
        global().push(level, LogSource::Rust, target, format!("{}", record.args()));

        if let Some(delegate) = &self.delegate {
            delegate.log(record);
        }
    }

    fn flush(&self) {
        if let Some(delegate) = &self.delegate {
            delegate.flush();
        }
    }
}

static LOGGER_INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LOGGER_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the ring-buffer logger actually owns the global `log` slot.
/// When true, Rust logs are already captured directly and the `log://log`
/// event listener must not also push them (double capture).
pub fn logger_is_active() -> bool {
    LOGGER_ACTIVE.load(Ordering::Acquire)
}

/// Install the ring-buffer logger as the global `log` logger. Safe to call
/// multiple times — only the first call has effect. If another logger is
/// already installed, this is a no-op (we can't safely steal it from the
/// `log` crate's static slot) and we log a warning via `eprintln!`.
pub fn install_logger() {
    if LOGGER_INSTALLED.swap(true, Ordering::AcqRel) {
        return;
    }
    let logger = Box::new(BufferLogger { delegate: None });
    if log::set_boxed_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
        LOGGER_ACTIVE.store(true, Ordering::Release);
    } else {
        // Another logger is in place; we'll only capture JS-side logs.
        eprintln!(
            "[TAURI_MCP] log::set_boxed_logger failed (another logger is installed). \
             Rust logs will not be captured in the MCP ring buffer; JS logs still are."
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_and_query_tail() {
        let buf = LogBuffer::new(10);
        for i in 0..5 {
            buf.push("info", LogSource::Rust, None, format!("msg {}", i));
        }
        let q = LogQuery {
            limit: Some(3),
            ..Default::default()
        };
        let r = buf.query(&q);
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[2].message, "msg 4");
        assert_eq!(r.total_matched, 5);
    }

    #[test]
    fn ring_buffer_drops_oldest() {
        let buf = LogBuffer::new(3);
        for i in 0..5 {
            buf.push("info", LogSource::Rust, None, format!("m{}", i));
        }
        let r = buf.query(&LogQuery::default());
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0].message, "m2");
        assert_eq!(r.dropped_total, 2);
    }

    #[test]
    fn level_filter_is_threshold() {
        let buf = LogBuffer::new(10);
        buf.push("debug", LogSource::Rust, None, "d".into());
        buf.push("info", LogSource::Rust, None, "i".into());
        buf.push("warn", LogSource::Rust, None, "w".into());
        buf.push("error", LogSource::Rust, None, "e".into());
        let r = buf.query(&LogQuery {
            level: Some("warn".into()),
            ..Default::default()
        });
        assert_eq!(r.entries.len(), 2);
        assert!(r.entries.iter().all(|e| e.level == "warn" || e.level == "error"));
    }

    #[test]
    fn since_id_paginates() {
        let buf = LogBuffer::new(10);
        for i in 0..5 {
            buf.push("info", LogSource::Rust, None, format!("m{}", i));
        }
        let first = buf.query(&LogQuery { limit: Some(2), ..Default::default() });
        let cursor = first.next_cursor.unwrap();
        let second = buf.query(&LogQuery { since_id: Some(cursor), ..Default::default() });
        assert!(second.entries.iter().all(|e| e.id > cursor));
    }

    #[test]
    fn source_filter() {
        let buf = LogBuffer::new(10);
        buf.push("info", LogSource::Rust, None, "r".into());
        buf.push("info", LogSource::Js, None, "j".into());
        let r = buf.query(&LogQuery {
            source: Some(LogSource::Js),
            ..Default::default()
        });
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].message, "j");
    }

    #[test]
    fn contains_filter_case_insensitive() {
        let buf = LogBuffer::new(10);
        buf.push("info", LogSource::Rust, None, "Connection refused".into());
        buf.push("info", LogSource::Rust, None, "ok".into());
        let r = buf.query(&LogQuery {
            contains: Some("REFUSED".into()),
            ..Default::default()
        });
        assert_eq!(r.entries.len(), 1);
    }

    #[test]
    fn mark_and_between_returns_bracketed_entries() {
        let buf = LogBuffer::new(50);
        buf.push("info", LogSource::Rust, None, "before".into());
        buf.mark("click", None);
        buf.push("info", LogSource::Js, None, "during-1".into());
        buf.push("warn", LogSource::Js, None, "during-2".into());
        buf.mark("click", None);
        buf.push("info", LogSource::Rust, None, "after".into());

        let r = buf.query(&LogQuery {
            between: Some("click".into()),
            ..Default::default()
        });
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].message, "during-1");
        assert_eq!(r.entries[1].message, "during-2");
        assert!(r.between_bounds.is_some());
    }

    #[test]
    fn between_with_only_begin_uses_now_as_upper() {
        let buf = LogBuffer::new(50);
        buf.mark("action", None);
        buf.push("info", LogSource::Rust, None, "mid".into());
        let r = buf.query(&LogQuery {
            between: Some("action".into()),
            ..Default::default()
        });
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].message, "mid");
    }

    #[test]
    fn between_unknown_tag_returns_empty() {
        let buf = LogBuffer::new(50);
        buf.push("info", LogSource::Rust, None, "x".into());
        let r = buf.query(&LogQuery {
            between: Some("nope".into()),
            ..Default::default()
        });
        assert_eq!(r.entries.len(), 0);
        assert!(r.between_bounds.is_none());
    }

    #[test]
    fn markers_hidden_by_default() {
        let buf = LogBuffer::new(50);
        buf.mark("a", None);
        let r = buf.query(&LogQuery::default());
        assert_eq!(r.entries.len(), 0);
        let r2 = buf.query(&LogQuery { include_markers: Some(true), ..Default::default() });
        assert_eq!(r2.entries.len(), 1);
    }

    #[test]
    fn plugin_chatter_hidden_by_default() {
        let buf = LogBuffer::new(50);
        buf.push("info", LogSource::Rust, Some("tauri_plugin_mcp::socket_server".into()), "[TAURI_MCP] Received command: ping".into());
        buf.push("trace", LogSource::Js, None, "localhost/ TAURI-PLUGIN-MCP: Received wait-for".into());
        buf.push("info", LogSource::Js, None, "AutoSavePlugin: saved".into());
        let r = buf.query(&LogQuery::default());
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].message, "AutoSavePlugin: saved");
        assert_eq!(r.counts.plugin, 2);

        let r2 = buf.query(&LogQuery { include_plugin: Some(true), ..Default::default() });
        assert_eq!(r2.entries.len(), 3);
    }

    #[test]
    fn coalesces_consecutive_duplicates() {
        let buf = LogBuffer::new(50);
        for _ in 0..100 {
            buf.push("warn", LogSource::Js, None, "render-loop spam".into());
        }
        let r = buf.query(&LogQuery::default());
        assert_eq!(r.entries.len(), 1, "100 identical pushes should coalesce");
        assert_eq!(r.entries[0].repeat, 100);
    }

    #[test]
    fn coalesce_run_capped_so_cursors_see_progress() {
        let buf = LogBuffer::new(50);
        for _ in 0..250 {
            buf.push("warn", LogSource::Js, None, "render-loop spam".into());
        }
        let r = buf.query(&LogQuery::default());
        // Runs are capped at MAX_COALESCE_REPEATS, so 250 pushes yield
        // multiple entries (new ids) instead of one ever-growing entry.
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0].repeat, MAX_COALESCE_REPEATS);
        assert_eq!(r.entries[1].repeat, MAX_COALESCE_REPEATS);
        assert_eq!(r.entries[2].repeat, 50);
        assert!(r.entries[0].id < r.entries[1].id);
    }

    #[test]
    fn push_returns_assigned_or_coalesced_id() {
        let buf = LogBuffer::new(50);
        let a = buf.push("info", LogSource::Js, None, "x".into());
        let b = buf.push("info", LogSource::Js, None, "x".into());
        assert_eq!(a, b, "coalesced push returns the existing entry id");
        let c = buf.push("info", LogSource::Js, None, "y".into());
        assert!(c > a);
    }

    #[test]
    fn coalesce_breaks_on_different_message() {
        let buf = LogBuffer::new(50);
        buf.push("info", LogSource::Js, None, "a".into());
        buf.push("info", LogSource::Js, None, "a".into());
        buf.push("info", LogSource::Js, None, "b".into());
        buf.push("info", LogSource::Js, None, "a".into());
        let r = buf.query(&LogQuery::default());
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0].repeat, 2);
        assert_eq!(r.entries[1].repeat, 1);
        assert_eq!(r.entries[2].repeat, 1);
    }

    #[test]
    fn long_messages_truncated() {
        let buf = LogBuffer::new(2);
        let big = "x".repeat(MAX_MESSAGE_LEN + 100);
        buf.push("info", LogSource::Rust, None, big);
        let r = buf.query(&LogQuery::default());
        assert!(r.entries[0].message.ends_with("…[truncated]"));
        assert!(r.entries[0].message.len() <= MAX_MESSAGE_LEN + 20);
    }

    #[test]
    fn long_multibyte_messages_truncated_on_char_boundary() {
        let buf = LogBuffer::new(2);
        // 8191 ASCII bytes then a 3-byte CJK char, so byte 8192 sits inside 好.
        let mut big = "x".repeat(MAX_MESSAGE_LEN - 1);
        big.push_str("好");
        big.push_str(&"y".repeat(100));
        buf.push("info", LogSource::Js, None, big);
        let r = buf.query(&LogQuery::default());
        let stored = &r.entries[0].message;
        assert!(stored.ends_with("…[truncated]"));
        let prefix = stored.strip_suffix("…[truncated]").expect("suffix");
        assert!(prefix.is_char_boundary(prefix.len()));
        assert!(prefix.len() <= MAX_MESSAGE_LEN);
        assert!(!prefix.contains('好'));
    }
}
