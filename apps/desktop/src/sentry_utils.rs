/// Capture a warning message to Sentry.
pub fn capture_warning(message: &str) {
    sentry::capture_message(message, sentry::Level::Warning);
}
