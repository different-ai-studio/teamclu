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
    /// Auto-approve tools, but forward questions.
    ///
    /// For a client that can answer a question and cannot approve a tool. The
    /// ESP32 is exactly that: it renders `InteractiveQuestion` as an on-screen
    /// menu, and has no surface at all for "may I run bash".
    ///
    /// Putting it on plain [`Ask`] to get the menu also un-suppressed tool
    /// approvals, which nothing on the device presents — the turn parked on a
    /// permission card nobody could see, with Think already showing and its
    /// deadline cleared. That is the failure the voice path was given full
    /// access to escape in the first place; this variant keeps the escape and
    /// the menu.
    QuestionsOnly,
}

impl PermissionPolicy {
    /// True when tool permissions are pre-granted — the runtime must never
    /// block asking whether it may act.
    pub fn is_full_access(self) -> bool {
        matches!(self, Self::Full | Self::QuestionsOnly)
    }

    /// True when a blocking `question` must be answered by the runtime itself
    /// rather than forwarded.
    ///
    /// Split from [`Self::is_full_access`] because the two are not the same
    /// question: "may I act" and "which of these did you mean" can have
    /// different answerers, and on the ESP32 they do.
    pub fn auto_rejects_questions(self) -> bool {
        matches!(self, Self::Full)
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
            Self::QuestionsOnly => "questions_only",
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
    fn questions_only_grants_tools_but_forwards_questions() {
        // The whole reason the variant exists. If these two ever agree again,
        // the ESP32 either loses its menu or parks on a permission card that
        // has no screen to appear on.
        let p = PermissionPolicy::QuestionsOnly;
        assert!(p.is_full_access(), "tools must not block");
        assert!(
            !p.auto_rejects_questions(),
            "questions must reach the device"
        );

        assert!(PermissionPolicy::Full.auto_rejects_questions());
        assert!(!PermissionPolicy::Ask.is_full_access());
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
