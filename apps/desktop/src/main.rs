// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Strip identity from an event before it leaves the machine (SEC-4).
///
/// `send_default_pii` is off, which stops the SDK attaching the OS user and IP
/// on its own — but integrations and hand-written `configure_scope` calls can
/// still put a `user`, the hostname, or request cookies/headers on an event.
/// This is the one place that guarantees none of those go out.
fn scrub_pii(
    mut event: sentry::protocol::Event<'static>,
) -> Option<sentry::protocol::Event<'static>> {
    event.user = None;
    event.server_name = None;
    if let Some(request) = event.request.as_mut() {
        request.cookies = None;
        request.env.clear();
        request.headers.retain(|name, _| {
            !matches!(
                name.to_ascii_lowercase().as_str(),
                "cookie" | "authorization"
            )
        });
    }
    Some(event)
}

fn main() {
    let _sentry_guard = sentry::init((
        "https://f7626cc6e80f4561b1673dd027742714@o60909.ingest.us.sentry.io/4511110362169344",
        sentry::ClientOptions {
            release: sentry::release_name!(),
            // Crash reports need a stack and a release, not who was at the
            // keyboard. Default PII includes the OS username and the client IP.
            send_default_pii: false,
            before_send: Some(std::sync::Arc::new(scrub_pii)),
            environment: Some(
                if cfg!(debug_assertions) {
                    "development"
                } else {
                    "production"
                }
                .into(),
            ),
            ..Default::default()
        },
    ));

    teamclu_lib::run()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_pii_drops_user_host_cookies_and_auth_headers() {
        let mut event = sentry::protocol::Event::new();
        event.user = Some(sentry::protocol::User {
            username: Some("matt".into()),
            ..Default::default()
        });
        event.server_name = Some("matts-macbook.local".into());
        let mut request = sentry::protocol::Request {
            cookies: Some("session=abc".into()),
            ..Default::default()
        };
        request
            .headers
            .insert("Authorization".into(), "Bearer x".into());
        request.headers.insert("Cookie".into(), "a=b".into());
        request
            .headers
            .insert("Content-Type".into(), "application/json".into());
        request.env.insert("REMOTE_ADDR".into(), "10.0.0.1".into());
        event.request = Some(request);

        let scrubbed = scrub_pii(event).expect("event is kept, not dropped");
        assert!(scrubbed.user.is_none());
        assert!(scrubbed.server_name.is_none());
        let request = scrubbed.request.expect("request block kept");
        assert!(request.cookies.is_none());
        assert!(request.env.is_empty());
        assert_eq!(request.headers.len(), 1);
        assert!(request.headers.contains_key("Content-Type"));
    }
}
