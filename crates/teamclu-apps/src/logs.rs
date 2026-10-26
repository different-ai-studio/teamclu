//! `logs` — the deployed function's own output.

use serde_json::{json, Value};

use crate::row::{app_path, row_id, row_str};
use crate::AppOps;

/// What to read. Every field is optional; [`LogsArgs::query`] bounds them.
#[derive(Debug, Clone, Default)]
pub struct LogsArgs {
    pub since_minutes: Option<u64>,
    pub limit: Option<u64>,
    /// `app`, `request` or `all`.
    pub kind: Option<String>,
    pub contains: Option<String>,
    pub request_id: Option<String>,
}

struct LogsQuery {
    since_minutes: u64,
    kind: String,
    query: String,
}

impl LogsArgs {
    /// The window and the row cap are bounded here as well as server-side: an
    /// app under load writes more in ten minutes than a turn can hold, and a
    /// reply large enough to blow the context is worse than no logs at all.
    fn query(&self) -> Result<LogsQuery, String> {
        let since_minutes = self.since_minutes.unwrap_or(30).clamp(1, 7 * 24 * 60);
        let limit = self.limit.unwrap_or(100).clamp(1, 200);
        let kind = self.kind.clone().unwrap_or_else(|| "app".to_string());
        if !matches!(kind.as_str(), "app" | "request" | "all") {
            return Err(format!(
                "Unknown kind: {kind} (expected app, request or all)"
            ));
        }
        let mut query = format!("?sinceMinutes={since_minutes}&limit={limit}&kind={kind}");
        if let Some(contains) = &self.contains {
            query.push_str(&format!("&contains={}", urlencoding::encode(contains)));
        }
        if let Some(request_id) = &self.request_id {
            query.push_str(&format!("&requestId={}", urlencoding::encode(request_id)));
        }
        Ok(LogsQuery {
            since_minutes,
            kind,
            query,
        })
    }
}

impl AppOps<'_> {
    pub async fn logs(&self, row: &Value, args: &LogsArgs) -> Result<Value, String> {
        let app_id = row_id(row)?;
        let fc_status = row_str(row, "fcStatus").unwrap_or("");
        if fc_status.is_empty() || fc_status == "not_deployed" {
            return Err(format!(
                "This app has never been deployed, so it has no logs yet. Deploy it first ({}).",
                self.surface().step("manage_app", "deploy")
            ));
        }
        let q = args.query()?;
        let out = self
            .get(
                &app_path(&app_id, &format!("/logs{}", q.query)),
                "Reading the app's logs (needs prompt on it)",
            )
            .await?;
        Ok(json!({
            "action": "logs",
            "app_id": app_id,
            "since_minutes": q.since_minutes,
            "kind": q.kind,
            "entries": out.get("items").cloned().unwrap_or(json!([])),
            "truncated": out.get("truncated").cloned().unwrap_or(json!(false)),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_and_row_cap_are_bounded_and_the_kind_checked() {
        let q = LogsArgs {
            since_minutes: Some(1_000_000),
            limit: Some(5000),
            contains: Some("a b".into()),
            ..Default::default()
        }
        .query()
        .unwrap();
        assert_eq!(
            q.query,
            "?sinceMinutes=10080&limit=200&kind=app&contains=a%20b"
        );
        let bad = LogsArgs {
            kind: Some("debug".into()),
            ..Default::default()
        };
        assert!(bad.query().is_err());
    }
}
