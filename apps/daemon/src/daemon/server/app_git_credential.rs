//! `{"cmd":"app-git-credential","appId":...}` — mint a JIT Gitea deploy key.
//!
//! Asked for by `amuxd git-ssh`, the `core.sshCommand` shim git runs for every
//! ssh connection it opens inside an app checkout. The daemon is the only
//! process on the machine holding a cloud identity, so it is the one that can
//! ask; the shim itself carries no credential of any kind.
//!
//! Reply shape mirrors the other JSON sock commands:
//! `{"ok":true,"result":{"remoteUrl":…,"privateKeyPem":…}}` or
//! `{"ok":false,"error":"…"}`. The error string is written to the agent's
//! stderr by the shim, so it has to read as a reason a human can act on — an
//! `ssh` failure alone looks like a network problem.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::backend::Backend;

use super::DaemonServer;

impl DaemonServer {
    /// Answer on a task, never inline.
    ///
    /// This is a round trip to the cloud, and the caller is a `git push` that
    /// happens whenever an agent feels like committing. Awaited on the select
    /// loop it would stall every session for the length of that request.
    pub(crate) async fn handle_app_git_credential(
        &self,
        payload: Value,
        reply_tx: tokio::sync::oneshot::Sender<String>,
    ) {
        let backend = Arc::clone(&self.backend);
        tokio::spawn(async move {
            let _ = reply_tx.send(app_git_credential_reply(backend, &payload).await);
        });
    }
}

async fn app_git_credential_reply(backend: Arc<dyn Backend>, payload: &Value) -> String {
    let app_id = payload
        .get("appId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(app_id) = app_id else {
        return json!({ "ok": false, "error": "appId is required" }).to_string();
    };

    // `revoke` hands a key back the moment ssh exits, which is what keeps a
    // repo from accumulating live write credentials. Anything else issues one.
    if payload.get("action").and_then(Value::as_str) == Some("revoke") {
        let Some(key_id) = payload.get("deployKeyId").and_then(Value::as_i64) else {
            return json!({ "ok": false, "error": "deployKeyId is required to revoke" })
                .to_string();
        };
        return match backend.revoke_app_git_credential(app_id, key_id).await {
            Ok(()) => json!({ "ok": true, "result": { "revoked": true } }).to_string(),
            Err(e) => {
                // Debug, not warn: the cloud's expiry sweep still collects it,
                // and the push this follows has already succeeded.
                tracing::debug!(app_id, error = %e, "app git credential revoke failed");
                json!({ "ok": false, "error": e.to_string() }).to_string()
            }
        };
    }

    match backend.app_git_credential(app_id).await {
        Ok(cred) => json!({
            "ok": true,
            "result": {
                "remoteUrl": cred.remote_url,
                "privateKeyPem": cred.private_key_pem,
                "deployKeyId": cred.deploy_key_id,
            },
        })
        .to_string(),
        Err(e) => {
            // Logged at warn, not error: a push from a machine whose daemon has
            // no access to the app is a legitimate "no", not a daemon fault.
            tracing::warn!(app_id, error = %e, "app git credential refused");
            json!({ "ok": false, "error": e.to_string() }).to_string()
        }
    }
}
