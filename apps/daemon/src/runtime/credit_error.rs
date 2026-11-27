//! Recognise the AI gateway's "out of credits" refusals inside a provider error.
//!
//! The team gateway answers 402 with one of two codes
//! (`services/ai-gateway/src/credits.ts`):
//!
//! - `insufficient_credits` — the team wallet is empty; every member is stopped
//!   and the fix is a top-up.
//! - `quota_exceeded` — one member hit their per-period limit; the fix is to
//!   raise that limit.
//!
//! pi forwards the gateway body as the turn's error detail, e.g.
//! `402: {"code":"insufficient_credits","message":"…"}`. Callers use this to
//! replace that raw JSON with a sentence that says what happened and how to
//! recover. The frontend twin is `packages/app/src/lib/agent/credit-error.ts`;
//! keep the two in step.

/// Stable reason codes, also written into `metadata.failure_reason` on a
/// failed AGENT_REPLY so every client can render the cause after a reload.
pub const INSUFFICIENT_CREDITS: &str = "insufficient_credits";
pub const QUOTA_EXCEEDED: &str = "quota_exceeded";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreditErrorKind {
    InsufficientCredits,
    QuotaExceeded,
}

impl CreditErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::InsufficientCredits => INSUFFICIENT_CREDITS,
            Self::QuotaExceeded => QUOTA_EXCEEDED,
        }
    }
}

/// The gateway credit refusal named in `text`, if any.
///
/// Matches the code as a whole token so unrelated codes that merely end the
/// same way (`app_storage_quota_exceeded`) are not mistaken for a member quota.
pub fn detect(text: &str) -> Option<CreditErrorKind> {
    if contains_token(text, INSUFFICIENT_CREDITS) {
        Some(CreditErrorKind::InsufficientCredits)
    } else if contains_token(text, QUOTA_EXCEEDED) {
        Some(CreditErrorKind::QuotaExceeded)
    } else {
        None
    }
}

fn contains_token(haystack: &str, needle: &str) -> bool {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    haystack.match_indices(needle).any(|(start, _)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + needle.len()..].chars().next();
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_gateway_body_pi_forwards() {
        assert_eq!(
            detect(
                r#"402: {"code":"insufficient_credits","message":"the team's credit balance is exhausted"}"#
            ),
            Some(CreditErrorKind::InsufficientCredits)
        );
        assert_eq!(
            detect(r#"402 {"error":{"code":"quota_exceeded","message":"member quota reached"}}"#),
            Some(CreditErrorKind::QuotaExceeded)
        );
    }

    #[test]
    fn ignores_other_provider_errors_and_lookalike_codes() {
        assert_eq!(detect("400 You're out of extra usage."), None);
        assert_eq!(detect("503 upstream_billing_error"), None);
        assert_eq!(detect(r#"409 {"code":"app_storage_quota_exceeded"}"#), None);
        assert_eq!(detect(""), None);
    }
}
