pub mod commands;

use serde_json::{Map, Value};
use tauri::AppHandle;
use tauri_plugin_aptabase::EventTracker;

/// The Aptabase app key is a single hardcoded constant shared by every build
/// this repository produces (`lib.rs`, `A-US-…`), and nothing in
/// `brand-setup` / `build.config.json` overrides it. So a copilot361 install
/// and a teamclu install report into the *same* Aptabase project — which is
/// fine, as long as every event says which brand it came from. Until this
/// existed the DAU number was an unsplittable sum of all brands.
///
/// `APP_SHORT_NAME` is the identifier that actually differs per brand
/// (`app.shortName`, injected by `build.rs`): `teamclu`, `copilot361`,
/// `teamclaw` for betly. It is not the workflow's brand id — betly's short
/// name is `teamclaw` — but it is unique across the brands we ship and it is
/// the same key the storage namespace is keyed by, so the analytics dimension
/// and the on-disk one cannot drift.
fn with_brand(props: Option<Value>) -> Value {
    let mut map = match props {
        Some(Value::Object(map)) => map,
        // Aptabase's ingest only accepts a flat object. A non-object payload
        // would come back 4xx, and the plugin's dispatcher drops 4xx without
        // re-queueing — so keep it as a field instead of losing the event.
        Some(other) => {
            let mut map = Map::new();
            map.insert("props".into(), other);
            map
        }
        None => Map::new(),
    };
    map.insert("brand".into(), Value::from(crate::commands::APP_SHORT_NAME));
    Value::Object(map)
}

/// Forward an event to Aptabase with this build's brand attached.
///
/// Every `track_event` call in this app goes through here; calling the plugin's
/// `track_event` directly is what let `app_started` ship without a brand.
pub fn track(app: &AppHandle, event_name: &str, props: Option<Value>) {
    let _ = app.track_event(event_name, Some(with_brand(props)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adds_brand_to_existing_props() {
        let out = with_brand(Some(json!({ "version": "1.2.3", "platform": "macos" })));
        assert_eq!(out["brand"], json!(crate::commands::APP_SHORT_NAME));
        assert_eq!(out["version"], json!("1.2.3"));
        assert_eq!(out["platform"], json!("macos"));
    }

    #[test]
    fn adds_brand_when_there_are_no_props() {
        // `app_exited` passes None — it must still carry the dimension.
        let out = with_brand(None);
        assert_eq!(out["brand"], json!(crate::commands::APP_SHORT_NAME));
        assert_eq!(out.as_object().map(Map::len), Some(1));
    }

    #[test]
    fn keeps_a_non_object_payload_rather_than_dropping_it() {
        let out = with_brand(Some(json!("oops")));
        assert_eq!(out["brand"], json!(crate::commands::APP_SHORT_NAME));
        assert_eq!(out["props"], json!("oops"));
    }

    #[test]
    fn caller_cannot_shadow_the_brand_dimension() {
        let out = with_brand(Some(json!({ "brand": "spoofed" })));
        assert_eq!(out["brand"], json!(crate::commands::APP_SHORT_NAME));
    }
}
