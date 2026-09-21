use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ConsentState {
    Granted,
    Denied,
    Undecided,
}

#[derive(Serialize, Deserialize)]
struct ConsentFile {
    state: ConsentState,
}

/// Brand-scoped: a white-label build stored the user's telemetry choice in the
/// *official* namespace while this path was hardcoded.
fn consent_path() -> Result<PathBuf, String> {
    Ok(crate::commands::brand_home_dir().join("telemetry-consent.json"))
}

#[tauri::command]
pub async fn telemetry_get_consent(_app: AppHandle) -> Result<ConsentState, String> {
    let path = consent_path()?;
    if !path.exists() {
        return Ok(ConsentState::Undecided);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ConsentFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(file.state)
}

#[tauri::command]
pub async fn telemetry_set_consent(_app: AppHandle, state: ConsentState) -> Result<(), String> {
    let path = consent_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&ConsentFile { state }).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(())
}

/// Events that ship regardless of consent, and the exact props each one may
/// carry. Same class as the `app_started` / `app_active` / `app_exited`
/// lifecycle trio `lib.rs` already emits unconditionally.
///
/// `session_created` is here because gating it made the number unreadable.
/// It was being compared against the ungated `app_started`, so the ratio
/// between the two measured the *consent rate*, not anything about the
/// product. iOS never gated it either (`AnalyticsSink` has no consent check),
/// so the same event name meant two different populations per platform.
///
/// The bar for this list is an aggregate counter whose props identify nobody.
/// The prop allowlist is not decoration: the consent dialog promises we never
/// collect conversation content, code, file paths, project names or personal
/// information, and once an event ships without consent that promise would
/// otherwise rest on nobody ever adding a path-shaped prop to it. Props that
/// are not listed here are dropped before the event is sent.
const CONSENT_EXEMPT_EVENTS: &[(&str, &[&str])] =
    &[("session_created", &["participantCount", "hasIdea"])];

fn consent_exempt_props(event_name: &str) -> Option<&'static [&'static str]> {
    CONSENT_EXEMPT_EVENTS
        .iter()
        .find(|(name, _)| *name == event_name)
        .map(|(_, allowed)| *allowed)
}

/// Keep only the props an exempt event is allowed to carry.
fn retain_allowed_props(
    props: Option<serde_json::Value>,
    allowed: &[&str],
) -> Option<serde_json::Value> {
    let Some(serde_json::Value::Object(mut map)) = props else {
        // A payload that is not a flat object cannot be checked against the
        // allowlist, so it does not ship from a user who declined.
        return None;
    };
    map.retain(|key, _| allowed.contains(&key.as_str()));
    Some(serde_json::Value::Object(map))
}

/// Forward a product event to Aptabase. Consent-gated unless the event is on
/// [`CONSENT_EXEMPT_EVENTS`]; richer product events stay opt-in.
#[tauri::command]
pub async fn telemetry_track(
    app: AppHandle,
    event_name: String,
    props: Option<serde_json::Value>,
) -> Result<(), String> {
    // Before the consent read, so an exempt event still ships when the consent
    // file is missing or corrupt.
    if let Some(allowed) = consent_exempt_props(&event_name) {
        super::track(&app, &event_name, retain_allowed_props(props, allowed));
        return Ok(());
    }
    if !matches!(
        telemetry_get_consent(app.clone()).await?,
        ConsentState::Granted
    ) {
        return Ok(());
    }
    super::track(&app, &event_name, props);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_created_is_exempt_and_other_events_are_not() {
        assert!(consent_exempt_props("session_created").is_some());
        // The events that made the gate worth having stay behind it.
        assert!(consent_exempt_props("message_sent").is_none());
        assert!(consent_exempt_props("sign_in_started").is_none());
    }

    #[test]
    fn keeps_the_props_the_event_is_allowed_to_carry() {
        let out = retain_allowed_props(
            Some(json!({ "participantCount": 3, "hasIdea": true })),
            consent_exempt_props("session_created").unwrap(),
        );
        assert_eq!(out, Some(json!({ "participantCount": 3, "hasIdea": true })));
    }

    #[test]
    fn drops_a_prop_added_later_that_is_not_on_the_allowlist() {
        // The regression this guards: someone adds `workspacePath` to
        // `session_created` and it starts flowing from users who declined,
        // against the dialog's "never collected: file paths" promise.
        let out = retain_allowed_props(
            Some(json!({ "participantCount": 1, "workspacePath": "/Users/me/secret" })),
            consent_exempt_props("session_created").unwrap(),
        )
        .unwrap();
        assert_eq!(out["participantCount"], json!(1));
        assert!(out.get("workspacePath").is_none());
    }

    #[test]
    fn drops_a_payload_that_is_not_a_flat_object() {
        let allowed = consent_exempt_props("session_created").unwrap();
        assert_eq!(retain_allowed_props(Some(json!("oops")), allowed), None);
        assert_eq!(retain_allowed_props(None, allowed), None);
    }
}
