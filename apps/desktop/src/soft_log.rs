//! Logging helpers that must never take down the process.
//!
//! `tauri-plugin-log` chains fern to stdout / log-dir / webview. On a packaged
//! GUI app stdout (and the fern stderr fallback) are often closed, so a single
//! `log::info!` can panic with:
//! `Error performing stderr logging after error occurred during regular logging`
//! (TEAMCLU-RUST-3, seen while spawning amuxd). Critical paths — quit, daemon
//! spawn, webview recovery — use these helpers instead of bare `log::`.

use std::panic::AssertUnwindSafe;

/// Best-effort `log::info!`. Swallows panics from a broken logger backend.
pub fn info(message: &str) {
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
        log::info!("{message}");
    }));
}

/// Best-effort `log::warn!`.
pub fn warn(message: &str) {
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
        log::warn!("{message}");
    }));
}

/// Best-effort `log::error!`.
pub fn error(message: &str) {
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
        log::error!("{message}");
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soft_log_helpers_do_not_panic_without_a_logger() {
        // No global logger is installed in unit tests; `log::` is a no-op and
        // must not unwind through catch_unwind either.
        info("soft-log info ok");
        warn("soft-log warn ok");
        error("soft-log error ok");
    }
}
