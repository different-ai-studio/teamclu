//! How a runtime handles tool-permission and question requests.
//!
//! Interactive desktop sessions surface both to a human and wait. Unattended
//! runs (gateway conversations, cron jobs) have nobody to answer: a request
//! that waits for a client never resolves, the turn watchdog treats
//! "waiting on the user" as healthy rather than stalled, and the run hangs
//! until the cron timeout kills it. Those runtimes take [`Full`] instead.
//!
//! [`Full`]: PermissionPolicy::Full

use std::fmt;

/// Permission handling for one runtime session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionPolicy {
    /// Forward permission + question requests to clients and wait for a human.
    #[default]
    Ask,
    /// Full access: auto-approve every tool permission, and auto-reject
    /// blocking `question` requests so the turn keeps moving instead of
    /// waiting on a human who is not there.
    Full,
}

impl PermissionPolicy {
    /// True when the runtime must never block on a human.
    pub fn is_full_access(self) -> bool {
        matches!(self, Self::Full)
    }

    /// Stable wire string for RPC replies (`default` / `full_access`).
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Ask => "default",
            Self::Full => "full_access",
        }
    }

    /// Merge a client-supplied mode with gateway/cron defaults.
    ///
    /// Gateway-bound sessions default to [`Full`] when the client omits a mode
    /// (unattended). Interactive sessions default to [`Ask`]. An explicit
    /// client value always wins via [`from_wire`].
    pub fn resolve_for_session(is_gateway: bool, client_mode: &str) -> Self {
        let fallback = if is_gateway {
            Self::Full
        } else {
            Self::Ask
        };
        let wire = client_mode.trim();
        Self::from_wire((!wire.is_empty()).then_some(wire), fallback)
    }

    /// Parse the wire value used by cron payloads (`"default"` /
    /// `"full_access"`). Unknown and absent values fall back to `fallback`,
    /// so an old client that omits the field keeps its previous behavior.
    pub fn from_wire(value: Option<&str>, fallback: Self) -> Self {
        match value.map(str::trim) {
            Some("full_access") | Some("fullAccess") | Some("full") => Self::Full,
            Some("default") | Some("ask") => Self::Ask,
            _ => fallback,
        }
    }
}

impl fmt::Display for PermissionPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Ask => "default",
            Self::Full => "full_access",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_wire_reads_both_spellings_of_full_access() {
        for v in ["full_access", "fullAccess", "full", " full_access "] {
            assert_eq!(
                PermissionPolicy::from_wire(Some(v), PermissionPolicy::Ask),
                PermissionPolicy::Full,
                "{v}"
            );
        }
    }

    #[test]
    fn from_wire_reads_ask() {
        assert_eq!(
            PermissionPolicy::from_wire(Some("default"), PermissionPolicy::Full),
            PermissionPolicy::Ask
        );
        assert_eq!(
            PermissionPolicy::from_wire(Some("ask"), PermissionPolicy::Full),
            PermissionPolicy::Ask
        );
    }

    #[test]
    fn from_wire_falls_back_when_absent_or_unknown() {
        // An older desktop that predates the field must keep the caller's
        // default rather than silently flipping to Ask.
        assert_eq!(
            PermissionPolicy::from_wire(None, PermissionPolicy::Full),
            PermissionPolicy::Full
        );
        assert_eq!(
            PermissionPolicy::from_wire(Some("nonsense"), PermissionPolicy::Full),
            PermissionPolicy::Full
        );
    }

    #[test]
    fn resolve_for_session_gateway_and_interactive() {
        assert_eq!(
            PermissionPolicy::resolve_for_session(true, ""),
            PermissionPolicy::Full
        );
        assert_eq!(
            PermissionPolicy::resolve_for_session(true, "default"),
            PermissionPolicy::Ask
        );
        assert_eq!(
            PermissionPolicy::resolve_for_session(false, ""),
            PermissionPolicy::Ask
        );
        assert_eq!(
            PermissionPolicy::resolve_for_session(false, "full_access"),
            PermissionPolicy::Full
        );
    }

    #[test]
    fn display_round_trips_through_from_wire() {
        for p in [PermissionPolicy::Ask, PermissionPolicy::Full] {
            let s = p.to_string();
            assert_eq!(
                PermissionPolicy::from_wire(Some(&s), PermissionPolicy::Ask),
                p
            );
        }
    }
}
