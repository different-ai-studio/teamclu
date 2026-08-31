//! FC Sync API client — reqwest-based HTTP client with JWT injection
//! and FC error code mapping.
//!
//! All endpoints use `Authorization: Bearer <supabase-jwt>`.
//! FC custom PostgreSQL error codes:
//!   P0409 → SyncError::Conflict
//!   P0403 → SyncError::Auth
//!   P0410 → SyncError::SessionExpired
//!
//! NOTE: several structs and methods are reserved for the full OSS pull/push
//! pipeline (not yet wired into the sync dispatcher).
#![allow(dead_code)]

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::SyncError;

/// A single manifest item returned by /sync/manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestItem {
    pub path: String,
    pub version: i32,
    /// cipher_hash of the blob (sha256 of encrypted bytes)
    pub content_hash: Option<String>,
    pub size: Option<i64>,
    pub deleted: bool,
    pub change_seq: i64,
    pub updated_at: Option<String>,
}

/// One page of manifest results.
#[derive(Debug, Clone)]
pub struct ManifestPage {
    pub snapshot_seq: i64,
    pub items: Vec<ManifestItem>,
    pub next_cursor: Option<String>,
}

/// Result of /sync/upload/prepare.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResult {
    pub upload_session_id: String,
    pub oss_key: String,
    pub requires_upload: bool,
    pub presigned_put: Option<String>,
}

/// Result of /sync/upload/complete.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteResult {
    pub version: i32,
    pub content_hash: String,
    pub change_seq: i64,
}

/// Result of /sync/download.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub download_url: String,
    pub size: i64,
    pub ttl_sec: u64,
}

/// Success payload of one /sync/delete(-batch) item.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub version: i32,
    pub change_seq: i64,
}

// ── Batch endpoint types ──────────────────────────────────────────────────────

/// One item of a /sync/upload/prepare-batch request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareBatchItem {
    pub path: String,
    pub parent_version: i32,
    pub content_hash: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

/// One item of a /sync/delete-batch request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBatchItem {
    pub path: String,
    pub parent_version: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

/// Outcome of a single item inside a batch response. Mirrors the FC per-item
/// envelope: `{ ok:true, … }` → `Ok`; `{ ok:false, status:409, … }` → `Conflict`;
/// any other `{ ok:false, status, … }` → `Err`. Items are independent: one
/// `Conflict`/`Err` never affects its siblings (FC runs each as its own atomic op).
#[derive(Debug, Clone)]
pub enum BatchItemOutcome<T> {
    Ok(T),
    Conflict {
        remote_version: Option<i32>,
        remote_cipher_hash: Option<String>,
    },
    Err {
        status: u16,
        message: String,
    },
    /// The team has restricted this path and the caller is not granted it.
    ///
    /// Its own variant rather than an `Err { status: 403 }` because the engine
    /// treats it as terminal-and-quiet: no retry, no error counter, no red UI.
    /// Every other `Err` is something that might work next tick.
    Forbidden {
        message: String,
    },
}

/// One version history entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: i32,
    pub parent_version: i32,
    pub content_hash: Option<String>,
    pub size: i64,
    pub deleted: bool,
    pub created_by: Option<String>,
    pub created_by_node_id: Option<String>,
    pub created_at: String,
    pub message: Option<String>,
}

/// Result of POST /v1/teams.
///
/// The Cloud API response shape: `{ id, name, slug, createdAt, aiGatewayEndpoint, litellmKey }`.
/// `aiGatewayEndpoint` and `litellmKey` are nullable when LiteLLM provisioning
/// is skipped (e.g. local dev with LITELLM_MASTER_KEY unset).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamResult {
    #[serde(rename = "id")]
    pub team_id: String,
    #[serde(rename = "slug")]
    pub team_slug: String,
    #[serde(default)]
    pub ai_gateway_endpoint: Option<String>,
    #[serde(default)]
    pub litellm_key: Option<String>,
}

pub struct FcClient {
    pub client: Client,
    pub base_url: String,
    pub jwt: String,
}

impl FcClient {
    pub fn new(base_url: String, jwt: String) -> Self {
        Self {
            client: Client::new(),
            base_url,
            jwt,
        }
    }

    /// POST /v1/teams — unified team creation. Provisions LiteLLM team + key
    /// server-side and seeds team_workspace_config in one call. The legacy
    /// `/sync/create-team` endpoint was removed in 2026-05.
    ///
    /// `node_id` is accepted for backward compatibility with the previous
    /// signature but is no longer forwarded — the /v1/teams handler derives
    /// the owning actor's node from the JWT-authenticated user.
    pub async fn create_team(
        &self,
        team_name: &str,
        _node_id: Option<&str>,
    ) -> Result<CreateTeamResult, SyncError> {
        let body = serde_json::json!({ "name": team_name });
        let resp = self.post("/v1/teams", &body).await?;
        Ok(resp)
    }

    /// POST /sync/manifest — one page.
    pub async fn manifest(
        &self,
        team_id: &str,
        after_seq: i64,
        cursor: Option<String>,
        snapshot_seq: Option<i64>,
    ) -> Result<ManifestPage, SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "afterSeq": after_seq,
        });
        if let Some(c) = cursor {
            body["cursor"] = Value::String(c);
        }
        if let Some(s) = snapshot_seq {
            body["snapshotSeq"] = Value::Number(s.into());
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawPage {
            snapshot_seq: i64,
            items: Vec<ManifestItem>,
            next_cursor: Option<String>,
        }

        let page: RawPage = self.post("/v1/sync/manifest", &body).await?;
        Ok(ManifestPage {
            snapshot_seq: page.snapshot_seq,
            items: page.items,
            next_cursor: page.next_cursor,
        })
    }

    /// POST /sync/upload/prepare
    pub async fn upload_prepare(
        &self,
        team_id: &str,
        path: &str,
        parent_version: i32,
        content_hash: &str,
        size: u64,
        node_id: Option<&str>,
    ) -> Result<PrepareResult, SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "path": path,
            "parentVersion": parent_version,
            "contentHash": content_hash,
            "size": size,
        });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        self.post("/v1/sync/upload/prepare", &body).await
    }

    /// PUT blob to presigned URL.
    pub async fn put_blob(&self, presigned_url: &str, data: Vec<u8>) -> Result<(), SyncError> {
        let resp = self
            .client
            .put(presigned_url)
            .body(data)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            // Include the host that rejected the PUT (after any redirects) so a
            // 413/403 surfaces which hop returned it, not just the status.
            let host = resp.url().host_str().unwrap_or("<unknown host>");
            return Err(SyncError::Network(format!(
                "PUT blob failed ({host}): HTTP {}",
                resp.status()
            )));
        }
        Ok(())
    }

    /// POST /sync/upload/complete
    pub async fn upload_complete(
        &self,
        team_id: &str,
        upload_session_id: &str,
        node_id: Option<&str>,
    ) -> Result<CompleteResult, SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "uploadSessionId": upload_session_id,
        });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        self.post("/v1/sync/upload/complete", &body).await
    }

    /// POST /sync/download
    pub async fn download(
        &self,
        team_id: &str,
        content_hash: &str,
    ) -> Result<DownloadResult, SyncError> {
        let body = serde_json::json!({
            "teamId": team_id,
            "contentHash": content_hash,
        });
        self.post("/v1/sync/download", &body).await
    }

    /// GET blob from presigned URL, verifying cipher_hash after download.
    pub async fn get_blob(
        &self,
        download_url: &str,
        expected_cipher_hash: &str,
    ) -> Result<Vec<u8>, SyncError> {
        let resp = self
            .client
            .get(download_url)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            let host = resp.url().host_str().unwrap_or("<unknown host>");
            return Err(SyncError::Network(format!(
                "GET blob failed ({host}): HTTP {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?
            .to_vec();

        let actual_hash = super::crypto::sha256_hex(&bytes);
        if actual_hash != expected_cipher_hash {
            return Err(SyncError::HashMismatch {
                expected: expected_cipher_hash.to_string(),
                actual: actual_hash,
            });
        }
        Ok(bytes)
    }

    /// POST /sync/delete
    pub async fn delete_file(
        &self,
        team_id: &str,
        path: &str,
        parent_version: i32,
        node_id: Option<&str>,
    ) -> Result<i32, SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "path": path,
            "parentVersion": parent_version,
        });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DeleteResp {
            version: i32,
        }
        // Returns the tombstone's new version so callers can record it for a later
        // re-add CAS (see engine mark_tombstoned).
        let resp: DeleteResp = self.post("/v1/sync/delete", &body).await?;
        Ok(resp.version)
    }

    // ── Batch endpoints ───────────────────────────────────────────────────────
    //
    // Each returns one outcome per input item, in order, same length. A whole-
    // request failure (rate-limit 429, oversized, 5xx) surfaces as SyncError so
    // the caller's is_transient backoff applies to the entire batch. A 404 means
    // the FC is too old to know the endpoint → SyncError::BatchUnsupported, the
    // signal to fall back to the per-file path.

    /// POST /sync/upload/prepare-batch
    pub async fn upload_prepare_batch(
        &self,
        team_id: &str,
        items: &[PrepareBatchItem],
    ) -> Result<Vec<BatchItemOutcome<PrepareResult>>, SyncError> {
        let body = serde_json::json!({ "teamId": team_id, "items": items });
        let results = self
            .post_batch_raw("/v1/sync/upload/prepare-batch", &body, items.len())
            .await?;
        Ok(results.iter().map(parse_batch_item).collect())
    }

    /// POST /sync/upload/complete-batch
    ///
    /// `node_id` is sent as a **top-level** body field. FC's knowledge-sync hint
    /// reads `originNodeId` from `body.nodeId` (not from per-item fields), so
    /// omitting it leaves peers unable to filter own-push echoes.
    pub async fn upload_complete_batch(
        &self,
        team_id: &str,
        session_ids: &[String],
        node_id: Option<&str>,
    ) -> Result<Vec<BatchItemOutcome<CompleteResult>>, SyncError> {
        let items: Vec<Value> = session_ids
            .iter()
            .map(|s| serde_json::json!({ "uploadSessionId": s }))
            .collect();
        let mut body = serde_json::json!({ "teamId": team_id, "items": items });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        let results = self
            .post_batch_raw("/v1/sync/upload/complete-batch", &body, session_ids.len())
            .await?;
        Ok(results.iter().map(parse_batch_item).collect())
    }

    /// POST /sync/download-batch
    pub async fn download_batch(
        &self,
        team_id: &str,
        content_hashes: &[String],
    ) -> Result<Vec<BatchItemOutcome<DownloadResult>>, SyncError> {
        let items: Vec<Value> = content_hashes
            .iter()
            .map(|h| serde_json::json!({ "contentHash": h }))
            .collect();
        let body = serde_json::json!({ "teamId": team_id, "items": items });
        let results = self
            .post_batch_raw("/v1/sync/download-batch", &body, content_hashes.len())
            .await?;
        Ok(results.iter().map(parse_batch_item).collect())
    }

    /// POST /sync/delete-batch
    ///
    /// Per-item `node_id` stamps `created_by_node_id` on the tombstone; the
    /// optional top-level `node_id` is what FC copies into the MQTT hint's
    /// `originNodeId` (same contract as complete-batch).
    pub async fn delete_batch(
        &self,
        team_id: &str,
        items: &[DeleteBatchItem],
        node_id: Option<&str>,
    ) -> Result<Vec<BatchItemOutcome<DeleteResult>>, SyncError> {
        let mut body = serde_json::json!({ "teamId": team_id, "items": items });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        let results = self
            .post_batch_raw("/v1/sync/delete-batch", &body, items.len())
            .await?;
        Ok(results.iter().map(parse_batch_item).collect())
    }

    /// POST a batch body, returning the `results[]` array. Enforces the
    /// equal-length invariant; maps 404 → BatchUnsupported and other non-2xx →
    /// SyncError (preserving the HTTP status text so is_transient can detect 429).
    async fn post_batch_raw(
        &self,
        path: &str,
        body: &Value,
        expected_len: usize,
    ) -> Result<Vec<Value>, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 404 {
            return Err(SyncError::BatchUnsupported);
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        if !status.is_success() {
            let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
            let msg = body["error"].as_str().unwrap_or("<no error message>");
            return Err(SyncError::Internal(format!(
                "FC returned HTTP {status}: {msg}"
            )));
        }

        let parsed: Value = serde_json::from_slice(&bytes)
            .map_err(|e| SyncError::Internal(format!("batch response parse failed: {e}")))?;
        let results = parsed
            .get("results")
            .and_then(|r| r.as_array())
            .cloned()
            .ok_or_else(|| SyncError::Internal("batch response missing results[]".into()))?;

        if results.len() != expected_len {
            return Err(SyncError::Internal(format!(
                "batch results length {} != items {}",
                results.len(),
                expected_len
            )));
        }

        Ok(results)
    }

    /// GET /sync/versions — returns (versions, nextCursor).
    pub async fn list_versions(
        &self,
        team_id: &str,
        path: &str,
        cursor: Option<String>,
    ) -> Result<(Vec<VersionInfo>, Option<String>), SyncError> {
        let mut url = format!(
            "{}/sync/versions?teamId={}&path={}",
            self.base_url,
            urlencoding_simple(team_id),
            urlencoding_simple(path)
        );
        if let Some(c) = cursor {
            url.push_str(&format!("&cursor={}", urlencoding_simple(&c)));
        }
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct VersionsResp {
            versions: Vec<VersionInfo>,
            #[serde(default)]
            next_cursor: Option<String>,
        }
        let parsed: VersionsResp = map_fc_response(resp).await?;
        Ok((parsed.versions, parsed.next_cursor))
    }

    /// POST /sync/set-mode — owner-only sync_mode switch (Tranche 5).
    pub async fn set_team_sync_mode(&self, team_id: &str, mode: &str) -> Result<String, SyncError> {
        let body = serde_json::json!({ "teamId": team_id, "mode": mode });
        #[derive(serde::Deserialize)]
        struct ModeResp {
            mode: String,
        }
        let resp: ModeResp = self.post("/v1/sync/set-mode", &body).await?;
        Ok(resp.mode)
    }

    /// POST /sync/team-mode — read sync_mode (Tranche 5).
    pub async fn get_team_sync_mode(&self, team_id: &str) -> Result<Option<String>, SyncError> {
        let body = serde_json::json!({ "teamId": team_id });
        #[derive(serde::Deserialize)]
        struct ModeResp {
            mode: Option<String>,
        }
        let resp: ModeResp = self.post("/v1/sync/team-mode", &body).await?;
        Ok(resp.mode)
    }

    /// Generic POST helper for ad-hoc endpoints (e.g. team_share enable flow).
    /// Returns the raw JSON value on 2xx; surfaces FC error envelope on non-2xx.
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value, SyncError> {
        self.post(path, body).await
    }

    /// Generic GET helper. Returns raw JSON value on 2xx.
    pub async fn get_json(&self, path: &str) -> Result<Value, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }

    /// Internal POST helper with JWT injection and error mapping.
    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<T, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }
}

/// Map an HTTP response to `T` or `SyncError`, handling FC custom error codes.
async fn map_fc_response<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, SyncError> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if status.is_success() {
        serde_json::from_slice(&bytes)
            .map_err(|e| SyncError::Internal(format!("response parse failed: {e}")))
    } else {
        // Try to parse FC error envelope { error, code, reason, remoteVersion, remoteHash, ... }
        let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let code = body["code"].as_str().unwrap_or("");
        let reason = body["reason"].as_str().unwrap_or("");

        // 409 CAS mismatch
        if status.as_u16() == 409 || code == "P0409" || reason == "cas-mismatch" {
            let remote_version = body["remoteVersion"].as_i64().map(|v| v as i32);
            let remote_cipher_hash = body["remoteHash"].as_str().map(|s| s.to_string());
            return Err(SyncError::Conflict {
                remote_version,
                remote_cipher_hash,
            });
        }

        // A restricted knowledge directory. Checked before the generic 403 so
        // it is not mistaken for an auth failure — the two want opposite
        // retry behaviour.
        if code == "PathForbidden" {
            return Err(SyncError::PathForbidden(
                body["error"].as_str().unwrap_or("path forbidden").to_string(),
            ));
        }

        // Auth errors
        if status.as_u16() == 403 || code == "P0403" {
            return Err(SyncError::Auth(
                body["error"].as_str().unwrap_or("forbidden").to_string(),
            ));
        }

        // Session expired / gone
        if status.as_u16() == 410 || code == "P0410" {
            return Err(SyncError::SessionExpired(
                body["error"]
                    .as_str()
                    .unwrap_or("session expired")
                    .to_string(),
            ));
        }

        // Path validation
        if status.as_u16() == 422 {
            return Err(SyncError::InvalidPath(
                body["error"].as_str().unwrap_or("invalid path").to_string(),
            ));
        }

        // 404 on these endpoints means "no such row", which several callers can
        // answer with an empty result instead of failing. Batch endpoints map
        // their own 404 to `BatchUnsupported` before ever reaching here.
        if status.as_u16() == 404 {
            return Err(SyncError::NotFound(
                body["error"].as_str().unwrap_or("not found").to_string(),
            ));
        }

        Err(SyncError::Internal(format!(
            "FC returned HTTP {}: {}",
            status,
            body["error"].as_str().unwrap_or("<no error message>")
        )))
    }
}

/// Parse one batch `results[i]` JSON object into a typed outcome. The success
/// payload deserializes into `T` (the extra `ok` field is ignored by serde).
fn parse_batch_item<T: serde::de::DeserializeOwned>(v: &Value) -> BatchItemOutcome<T> {
    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
    if ok {
        match serde_json::from_value::<T>(v.clone()) {
            Ok(t) => BatchItemOutcome::Ok(t),
            Err(e) => BatchItemOutcome::Err {
                status: 500,
                message: format!("item parse failed: {e}"),
            },
        }
    } else {
        let status = v.get("status").and_then(|s| s.as_u64()).unwrap_or(500) as u16;
        if status == 409 {
            BatchItemOutcome::Conflict {
                remote_version: v
                    .get("remoteVersion")
                    .and_then(|x| x.as_i64())
                    .map(|x| x as i32),
                remote_cipher_hash: v
                    .get("remoteHash")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
            }
        } else if v.get("code").and_then(|c| c.as_str()) == Some("PathForbidden") {
            BatchItemOutcome::Forbidden {
                message: v
                    .get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("path forbidden")
                    .to_string(),
            }
        } else {
            BatchItemOutcome::Err {
                status,
                message: v
                    .get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("batch item error")
                    .to_string(),
            }
        }
    }
}

fn urlencoding_simple(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_batch_item_ok_payload() {
        let v = json!({
            "ok": true,
            "version": 3,
            "contentHash": "abc",
            "changeSeq": 42,
        });
        match parse_batch_item::<CompleteResult>(&v) {
            BatchItemOutcome::Ok(r) => {
                assert_eq!(r.version, 3);
                assert_eq!(r.content_hash, "abc");
                assert_eq!(r.change_seq, 42);
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_batch_item_conflict_carries_remote() {
        let v = json!({
            "ok": false,
            "status": 409,
            "reason": "cas-mismatch",
            "remoteVersion": 7,
            "remoteHash": "deadbeef",
        });
        match parse_batch_item::<CompleteResult>(&v) {
            BatchItemOutcome::Conflict {
                remote_version,
                remote_cipher_hash,
            } => {
                assert_eq!(remote_version, Some(7));
                assert_eq!(remote_cipher_hash.as_deref(), Some("deadbeef"));
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    fn parse_batch_item_conflict_without_remote_fields() {
        // FC may omit remoteVersion/remoteHash (postgres path returns undefined).
        let v = json!({ "ok": false, "status": 409, "reason": "cas-mismatch" });
        match parse_batch_item::<CompleteResult>(&v) {
            BatchItemOutcome::Conflict {
                remote_version,
                remote_cipher_hash,
            } => {
                assert_eq!(remote_version, None);
                assert_eq!(remote_cipher_hash, None);
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    fn parse_batch_item_other_error_keeps_status() {
        let v = json!({ "ok": false, "status": 410, "error": "session expired" });
        match parse_batch_item::<CompleteResult>(&v) {
            BatchItemOutcome::Err { status, message } => {
                assert_eq!(status, 410);
                assert_eq!(message, "session expired");
            }
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[test]
    fn parse_batch_item_path_forbidden_is_its_own_outcome() {
        // Must NOT come back as `Err { status: 403 }`: the engine retries an
        // Err and deliberately does not retry this.
        let v = json!({
            "ok": false,
            "status": 403,
            "code": "PathForbidden",
            "error": "path is not accessible: knowledge/hr/a.md",
        });
        match parse_batch_item::<CompleteResult>(&v) {
            BatchItemOutcome::Forbidden { message } => {
                assert!(message.contains("not accessible"));
            }
            other => panic!("expected Forbidden, got {other:?}"),
        }
    }

    #[test]
    fn parse_batch_item_plain_403_is_still_an_error() {
        // A 403 without the code is an auth problem, which DOES clear by
        // retrying. Collapsing the two would make real auth failures permanent.
        let v = json!({ "ok": false, "status": 403, "error": "forbidden" });
        match parse_batch_item::<CompleteResult>(&v) {
            BatchItemOutcome::Err { status, .. } => assert_eq!(status, 403),
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[test]
    fn parse_batch_item_prepare_ignores_ok_field() {
        let v = json!({
            "ok": true,
            "uploadSessionId": "sess-1",
            "ossKey": "teams/t/blobs/…",
            "requiresUpload": true,
            "presignedPut": "https://oss/put",
        });
        match parse_batch_item::<PrepareResult>(&v) {
            BatchItemOutcome::Ok(r) => {
                assert_eq!(r.upload_session_id, "sess-1");
                assert!(r.requires_upload);
                assert_eq!(r.presigned_put.as_deref(), Some("https://oss/put"));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    /// FC publishes `originNodeId` from the **top-level** `body.nodeId` on
    /// complete-batch / delete-batch — not from per-item fields. These tests
    /// lock that request shape so MQTT echo filtering can work.
    #[tokio::test]
    async fn complete_batch_sends_top_level_node_id() {
        use wiremock::matchers::{body_partial_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sync/upload/complete-batch"))
            .and(body_partial_json(json!({
                "teamId": "t1",
                "nodeId": "mac-9f3c",
                "items": [{ "uploadSessionId": "sess-1" }],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "ok": true,
                    "version": 1,
                    "contentHash": "abc",
                    "changeSeq": 10,
                }],
            })))
            .expect(1)
            .mount(&srv)
            .await;

        let fc = FcClient::new(srv.uri(), "jwt".into());
        let out = fc
            .upload_complete_batch("t1", &["sess-1".into()], Some("mac-9f3c"))
            .await
            .expect("complete-batch");
        assert!(matches!(out.as_slice(), [BatchItemOutcome::Ok(_)]));
    }

    #[tokio::test]
    async fn put_blob_failure_names_the_host() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(413))
            .expect(1)
            .mount(&srv)
            .await;

        let fc = FcClient::new(srv.uri(), "jwt".into());
        let url = format!("{}/blob", srv.uri());
        let err = fc
            .put_blob(&url, b"payload".to_vec())
            .await
            .expect_err("a 413 must surface as an error");
        let msg = match err {
            SyncError::Network(m) => m,
            other => panic!("expected Network error, got {other:?}"),
        };
        // host_str() drops the port; the mock server is 127.0.0.1:<port>.
        assert!(msg.contains("127.0.0.1"), "error should name the host that returned 413: {msg}");
        assert!(msg.contains("413"), "error should name the status: {msg}");
    }

    #[tokio::test]
    async fn delete_batch_sends_top_level_node_id() {
        use wiremock::matchers::{body_partial_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sync/delete-batch"))
            .and(body_partial_json(json!({
                "teamId": "t1",
                "nodeId": "del-node",
                "items": [{
                    "path": "knowledge/a.md",
                    "parentVersion": 1,
                    "nodeId": "del-node",
                }],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "ok": true,
                    "version": 2,
                    "changeSeq": 11,
                }],
            })))
            .expect(1)
            .mount(&srv)
            .await;

        let fc = FcClient::new(srv.uri(), "jwt".into());
        let items = [DeleteBatchItem {
            path: "knowledge/a.md".into(),
            parent_version: 1,
            node_id: Some("del-node".into()),
        }];
        let out = fc
            .delete_batch("t1", &items, Some("del-node"))
            .await
            .expect("delete-batch");
        assert!(matches!(out.as_slice(), [BatchItemOutcome::Ok(_)]));
    }
}
