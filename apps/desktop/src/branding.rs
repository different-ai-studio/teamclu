//! Compile-time white-label helpers.
//!
//! STR-14 — one source for the brand's human-facing name.
//!
//! There used to be two, and they were different values by construction:
//!
//! - `build.rs` stamps `APP_DISPLAY_NAME` from build config
//!   `app.displayName ?? app.name` — the name meant for a person to read.
//! - `scripts/lib/branding.js` writes `tauri.conf.json` `productName` from
//!   `app.name` alone — the bundle name, which has to be filesystem- and
//!   installer-safe.
//!
//! `brand_name` read the second one. For any brand that sets both (the whole
//! reason `displayName` exists), the tray tooltip, the window titles and the
//! macOS app menu said the bundle name while the daemon env and the storage
//! namespace said the display name. Same product, two names, no way to notice
//! from either file alone.
//!
//! `APP_DISPLAY_NAME` wins: it is the one already carrying the
//! `displayName ?? name ?? "TeamClu"` fallback chain, and it is the one already
//! handed to amuxd (`commands::branded_amuxd_env`).

/// The brand's display name — what to put in front of a user.
pub fn brand_name() -> String {
    resolve_brand_name(Some(crate::commands::APP_DISPLAY_NAME))
}

/// The fallback rule, separated so it stays testable without a build config.
fn resolve_brand_name(configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("TeamClu")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_when_none() {
        assert_eq!(resolve_brand_name(None), "TeamClu");
    }

    #[test]
    fn falls_back_when_empty() {
        assert_eq!(resolve_brand_name(Some("")), "TeamClu");
        assert_eq!(resolve_brand_name(Some("   ")), "TeamClu");
    }

    #[test]
    fn uses_configured_name() {
        assert_eq!(resolve_brand_name(Some("Acme")), "Acme");
        assert_eq!(resolve_brand_name(Some("  Acme  ")), "Acme");
    }

    /// The point of the change: `brand_name` reads the build-time display name,
    /// not `tauri.conf.json`'s `productName`.
    #[test]
    fn brand_name_comes_from_app_display_name() {
        assert_eq!(brand_name(), crate::commands::APP_DISPLAY_NAME);
    }
}
