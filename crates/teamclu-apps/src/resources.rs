//! The plain Cloud API resources under one app: its environment, its cron
//! jobs, its custom domain and its data rows.
//!
//! Each method does one thing to one resource of an app already resolved.
//! Permission tiers are the server's to enforce and are only named in each
//! failure's "what was being done", so a 404 the API returns for "not
//! allowed" reads as the permission it probably is. Moved here from the
//! desktop's MCP handlers (P2.5 S2a), which have since been removed.

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::row::{app_brief, app_path, items_of, row_id, row_str};
use crate::{AppOps, ErrorKind, Method, OpError};

/// An object addressed by id, or by a name that must match exactly one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Named {
    Id(String),
    Name(String),
}

/// Exactly one of `candidates` (`(id, name)`) whose name equals `wanted`,
/// ignoring case.
///
/// The rule every name-addressed write follows: granting the wrong person
/// access, or deleting the wrong job, is not worth a fuzzy match, so none or
/// several matches come back as the list to pick an id from.
pub fn pick_by_name<'a>(
    candidates: &'a [(String, String)],
    wanted: &str,
    what: &str,
    id_field: &str,
) -> Result<&'a (String, String), OpError> {
    let lower = wanted.trim().to_lowercase();
    let matches: Vec<&(String, String)> = candidates
        .iter()
        .filter(|(_, name)| name.trim().to_lowercase() == lower)
        .collect();
    let listing = |rows: &[&(String, String)]| {
        Value::Array(
            rows.iter()
                .map(|(id, name)| json!({ id_field: id, "name": name }))
                .collect(),
        )
    };
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(OpError::not_found(
            "no_such_name",
            format!(
                "No {what} named {wanted:?}. Candidates: {}",
                listing(&candidates.iter().collect::<Vec<_>>())
            ),
        )),
        n => Err(OpError::not_found(
            "ambiguous_name",
            format!(
                "{wanted:?} matches {n} {what}s — pass {id_field} instead. Matches: {}",
                listing(&matches)
            ),
        )),
    }
}

// ─── env ─────────────────────────────────────────────────────────────────────

fn env_var_view(var: &Value) -> Value {
    json!({
        "key": var.get("key"),
        "is_secret": var.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
        // Null for a secret, for everyone — including whoever set it.
        "value": var.get("value"),
        "updated_at": var.get("updatedAt"),
    })
}

fn env_path(app_id: &str, key: &str) -> String {
    app_path(app_id, &format!("/env/{}", urlencoding::encode(key)))
}

// ─── cron ────────────────────────────────────────────────────────────────────

fn cron_job_view(job: &Value) -> Value {
    json!({
        "id": job.get("id"),
        "name": job.get("name"),
        "enabled": job.get("enabled"),
        "schedule": job.get("schedule"),
        "timezone": job.get("timezone"),
        "method": job.get("method"),
        "path": job.get("path"),
        "headers": job.get("headers"),
        "body": job.get("body"),
        "timeout_ms": job.get("timeoutMs"),
        "last_run_at": job.get("lastRunAt"),
        "next_run_at": job.get("nextRunAt"),
    })
}

fn cron_run_view(run: &Value) -> Value {
    json!({
        "id": run.get("id"),
        "started_at": run.get("startedAt"),
        "finished_at": run.get("finishedAt"),
        "status": run.get("status"),
        "response_status": run.get("responseStatus"),
        "duration_ms": run.get("durationMs"),
        "error": run.get("error"),
    })
}

/// The fields of a cron job's create or edit. Only what is `Some` is sent:
/// an edit leaves the rest as they were.
#[derive(Debug, Clone, Default)]
pub struct CronFields {
    pub name: Option<String>,
    /// Five cron fields: minute hour day-of-month month day-of-week.
    pub schedule: Option<String>,
    pub timezone: Option<String>,
    pub method: Option<String>,
    pub path: Option<String>,
    /// Header name → string value.
    pub headers: Option<Value>,
    /// `Some(None)` clears the body.
    pub body: Option<Option<String>>,
    pub timeout_ms: Option<u64>,
    pub enabled: Option<bool>,
}

impl CronFields {
    /// The request body, in the API's names.
    pub fn to_api(&self) -> Result<Value, OpError> {
        let mut out = Map::new();
        for (key, value) in [
            ("name", &self.name),
            ("schedule", &self.schedule),
            ("timezone", &self.timezone),
            ("method", &self.method),
            ("path", &self.path),
        ] {
            if let Some(value) = value {
                out.insert(key.to_string(), json!(value));
            }
        }
        if let Some(headers) = &self.headers {
            let map = headers.as_object().ok_or_else(|| {
                OpError::invalid(
                    "invalid_headers",
                    "headers must be an object of header name → string value",
                )
            })?;
            if map.values().any(|value| !value.is_string()) {
                return Err(OpError::invalid(
                    "invalid_headers",
                    "every header value must be a string",
                ));
            }
            out.insert("headers".to_string(), headers.clone());
        }
        if let Some(body) = &self.body {
            out.insert("body".to_string(), json!(body));
        }
        if let Some(ms) = self.timeout_ms {
            out.insert("timeoutMs".to_string(), json!(ms));
        }
        if let Some(enabled) = self.enabled {
            out.insert("enabled".to_string(), json!(enabled));
        }
        Ok(Value::Object(out))
    }
}

fn cron_job_path(app_id: &str, job_id: &str, rest: &str) -> String {
    app_path(
        app_id,
        &format!("/cron-jobs/{}{rest}", urlencoding::encode(job_id)),
    )
}

// ─── domain ──────────────────────────────────────────────────────────────────

fn domain_view(domain: &Value) -> Value {
    json!({
        "domain": domain.get("domain"),
        "verified": domain.get("verified").and_then(Value::as_bool).unwrap_or(false),
        "verified_at": domain.get("verifiedAt"),
        "dns": domain.get("dns").cloned().unwrap_or(json!([])),
    })
}

// ─── data ────────────────────────────────────────────────────────────────────

/// Opaque row key: unpadded base64url of the JSON array of primary-key values,
/// in the order the table's catalog reports them.
///
/// Mirrors `appDataRowKey` in the frontend and `decodeRowKey` on the server.
/// The caller passes a column → value map and this orders it, because a
/// composite key silently ordered wrong addresses a different row, not an
/// error.
pub fn data_row_key(primary_key: &[String], key: &Value) -> Result<String, OpError> {
    use base64::Engine as _;
    let bad = |m: String| OpError::invalid("invalid_row_key", m);
    let values: Vec<Value> = match key {
        Value::Array(a) => {
            if a.len() != primary_key.len() {
                return Err(bad(format!(
                    "key must have {} value(s), in this order: {}",
                    primary_key.len(),
                    primary_key.join(", ")
                )));
            }
            a.clone()
        }
        Value::Object(map) => {
            let mut out = Vec::with_capacity(primary_key.len());
            for column in primary_key {
                let value = map.get(column).ok_or_else(|| {
                    bad(format!(
                        "key is missing primary-key column {column:?} (needs: {})",
                        primary_key.join(", ")
                    ))
                })?;
                out.push(value.clone());
            }
            out
        }
        _ => {
            return Err(bad(
                "key must be an object of primary-key columns, or an array".to_string(),
            ))
        }
    };
    let json =
        serde_json::to_string(&values).map_err(|e| bad(format!("cannot encode key: {e}")))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

/// A key value in the type its column has (`information_schema` data_type).
///
/// The opaque key is the JSON of the values, so `["10023"]` and `[10023]`
/// name different rows. A command line only has text, and `--key sku=10023`
/// parsed as JSON is a number even when `sku` is `text`; going by the
/// column's type is the only way to get the row that was meant.
fn key_value_for_column(value: &Value, data_type: Option<&str>) -> Value {
    let Some(data_type) = data_type else {
        return value.clone();
    };
    let t = data_type.to_ascii_lowercase();
    let numeric = matches!(
        t.as_str(),
        "smallint" | "integer" | "bigint" | "numeric" | "decimal" | "real" | "double precision"
    );
    let boolean = t == "boolean";
    match value {
        Value::String(s) if numeric => serde_json::from_str::<serde_json::Number>(s.trim())
            .map(Value::Number)
            .unwrap_or_else(|_| value.clone()),
        Value::String(s) if boolean => match s.trim() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => value.clone(),
        },
        Value::Number(n) if !numeric => Value::String(n.to_string()),
        Value::Bool(b) if !boolean => Value::String(b.to_string()),
        _ => value.clone(),
    }
}

/// `key` (object or array) with each value in its column's type.
fn typed_key(key: &Value, columns: &[(String, Option<String>)]) -> Value {
    let type_of = |name: &str| {
        columns
            .iter()
            .find(|(c, _)| c == name)
            .and_then(|(_, t)| t.as_deref())
    };
    match key {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), key_value_for_column(v, type_of(k))))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .zip(columns.iter())
                .map(|(v, (_, t))| key_value_for_column(v, t.as_deref()))
                .chain(items.iter().skip(columns.len()).cloned())
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A `rows` read: page size, cursor, and an optional one-column filter.
#[derive(Debug, Clone, Default)]
pub struct RowsQuery {
    pub limit: Option<u64>,
    pub after: Option<String>,
    /// `asc` or `desc`.
    pub direction: Option<String>,
    /// `(column, op, value)`; op is eq, contains, isNull or notNull.
    pub filter: Option<(String, String, Option<String>)>,
}

/// A row addressed by its opaque key, or by its primary-key columns.
#[derive(Debug, Clone)]
pub enum RowRef {
    Opaque(String),
    Key(Value),
}

impl AppOps<'_> {
    // ─── env ─────────────────────────────────────────────────────────────────

    fn env_not_live(&self) -> String {
        format!(
            "Not live yet: the environment is baked into the function, so the app sees this on its next deploy ({}).",
            crate::step("deploy")
        )
    }

    pub async fn env_list(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let listing = self
            .get(
                &app_path(&app_id, "/env"),
                "Reading the app's environment (needs write on it)",
            )
            .await?;
        Ok(json!({
            "action": "list",
            "app_id": app_id,
            "can_write": listing.get("canWrite").and_then(Value::as_bool).unwrap_or(false),
            "pending_redeploy": row.get("envPendingRedeploy").and_then(Value::as_bool).unwrap_or(false),
            "variables": items_of(&listing).iter().map(env_var_view).collect::<Vec<_>>(),
        }))
    }

    pub async fn env_set(
        &self,
        row: &Value,
        key: &str,
        value: &str,
        is_secret: bool,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let saved = self
            .put(
                &env_path(&app_id, key),
                &json!({ "value": value, "isSecret": is_secret }),
                "Setting the variable (needs admin on the app)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "set",
            "app_id": app_id,
            "variable": env_var_view(&saved),
            "note": self.env_not_live(),
        }))
    }

    pub async fn env_delete(&self, row: &Value, key: &str) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        self.del(
            &env_path(&app_id, key),
            "Deleting the variable (needs admin on the app)",
        )
        .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "delete",
            "app_id": app_id,
            "key": key,
            "note": self.env_not_live(),
        }))
    }

    // ─── cron ────────────────────────────────────────────────────────────────

    async fn cron_jobs(&self, app_id: &str) -> Result<Vec<Value>, OpError> {
        let listing = self
            .get(
                &app_path(app_id, "/cron-jobs"),
                "Listing the app's scheduled tasks",
            )
            .await?;
        Ok(items_of(&listing))
    }

    /// The job `job` names, and its row (null when an id names no listed job).
    async fn resolve_cron_job(
        &self,
        app_id: &str,
        job: &Named,
    ) -> Result<(String, Value), OpError> {
        let jobs = self.cron_jobs(app_id).await?;
        let find = |id: &str| {
            jobs.iter()
                .find(|j| row_str(j, "id") == Some(id))
                .cloned()
                .unwrap_or(Value::Null)
        };
        match job {
            Named::Id(id) => Ok((id.clone(), find(id))),
            Named::Name(wanted) => {
                let named: Vec<(String, String)> = jobs
                    .iter()
                    .filter_map(|j| {
                        Some((
                            row_str(j, "id")?.to_string(),
                            row_str(j, "name")?.to_string(),
                        ))
                    })
                    .collect();
                let (id, _) = pick_by_name(&named, wanted, "scheduled task", "job_id")?;
                Ok((id.clone(), find(id)))
            }
        }
    }

    pub async fn cron_list(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let jobs = self.cron_jobs(&app_id).await?;
        Ok(json!({
            "action": "list",
            "app_id": app_id,
            "jobs": jobs.iter().map(cron_job_view).collect::<Vec<_>>(),
        }))
    }

    pub async fn cron_create(&self, row: &Value, fields: &CronFields) -> Result<Value, OpError> {
        if fields.name.is_none() || fields.schedule.is_none() {
            return Err(OpError::invalid(
                "name_and_schedule_required",
                "create needs a name and a schedule (five cron fields: minute hour day-of-month month day-of-week)",
            ));
        }
        let body = fields.to_api()?;
        let app_id = row_id(row)?;
        let job = self
            .post(
                &app_path(&app_id, "/cron-jobs"),
                &body,
                "Creating the scheduled task (needs admin on the app)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(json!({ "ok": true, "action": "create", "app_id": app_id, "job": cron_job_view(&job) }))
    }

    pub async fn cron_update(
        &self,
        row: &Value,
        job: &Named,
        fields: &CronFields,
    ) -> Result<Value, OpError> {
        let body = fields.to_api()?;
        if body.as_object().is_some_and(Map::is_empty) {
            return Err(OpError::invalid(
                "nothing_to_update",
                "update needs at least one field to change: name, schedule, timezone, method, path, headers, body, timeout_ms, enabled",
            ));
        }
        let app_id = row_id(row)?;
        let (job_id, _) = self.resolve_cron_job(&app_id, job).await?;
        let saved = self
            .patch(
                &cron_job_path(&app_id, &job_id, ""),
                &body,
                "Updating the scheduled task (needs admin on the app)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(
            json!({ "ok": true, "action": "update", "app_id": app_id, "job": cron_job_view(&saved) }),
        )
    }

    pub async fn cron_delete(&self, row: &Value, job: &Named) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let (job_id, found) = self.resolve_cron_job(&app_id, job).await?;
        self.del(
            &cron_job_path(&app_id, &job_id, ""),
            "Deleting the scheduled task (needs admin on the app)",
        )
        .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "delete",
            "app_id": app_id,
            "job_id": job_id,
            "name": found.get("name"),
        }))
    }

    pub async fn cron_run(&self, row: &Value, job: &Named) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let (job_id, _) = self.resolve_cron_job(&app_id, job).await?;
        // The task's own timeout goes up to 60 s, and the endpoint answers
        // only once the request it sends has.
        let outcome = self
            .call(
                Method::Post,
                &cron_job_path(&app_id, &job_id, "/run"),
                Some(&json!({})),
                Some(Duration::from_secs(90)),
                "Running the scheduled task now (needs admin on the app)",
            )
            .await?;
        Ok(json!({
            "ok": true,
            "action": "run",
            "app_id": app_id,
            "job_id": job_id,
            // A non-2xx from the app is still a successful call here, with
            // status "failed" — that is the answer the caller came for.
            "outcome": {
                "status": outcome.get("status"),
                "response_status": outcome.get("responseStatus"),
                "error": outcome.get("error"),
            },
            "note": "Running now does not move the schedule; next_run_at is unchanged.",
        }))
    }

    pub async fn cron_runs(
        &self,
        row: &Value,
        job: &Named,
        limit: Option<u64>,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let (job_id, _) = self.resolve_cron_job(&app_id, job).await?;
        let limit = limit.unwrap_or(20).clamp(1, 100);
        let listing = self
            .get(
                &cron_job_path(&app_id, &job_id, &format!("/runs?limit={limit}")),
                "Reading the task's run history",
            )
            .await?;
        Ok(json!({
            "action": "runs",
            "app_id": app_id,
            "job_id": job_id,
            "runs": items_of(&listing).iter().map(cron_run_view).collect::<Vec<_>>(),
        }))
    }

    // ─── domain ──────────────────────────────────────────────────────────────

    pub fn domain_show(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let bound = row_str(row, "customDomain");
        let verified = row_str(row, "customDomainVerifiedAt").is_some();
        // The TXT value embeds a token that is not on the app row, so the
        // records can only be re-read by binding the same name again — which
        // the server keeps idempotent for exactly this.
        let hint = (bound.is_some() && !verified).then(|| {
            format!(
                "Not served until verified. To see the DNS records again, run {} with the same domain — it keeps the token and any verification.",
                crate::step("domain set")
            )
        });
        Ok(json!({
            "action": "get",
            "app_id": app_id,
            "domain": bound,
            "verified": verified,
            "verified_at": row.get("customDomainVerifiedAt"),
            "url": app_brief(row)["url"].clone(),
            "hint": hint,
        }))
    }

    pub async fn domain_set(&self, row: &Value, domain: &str) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let saved = self
            .put(
                &app_path(&app_id, "/custom-domain"),
                &json!({ "domain": domain }),
                "Binding the domain (needs admin on the app)",
            )
            .await?;
        self.host.app_changed(row);
        let mut out = domain_view(&saved);
        out["ok"] = json!(true);
        out["action"] = json!("set");
        out["app_id"] = json!(app_id);
        out["next"] = json!(format!(
            "Publish these DNS records at the domain's DNS provider, then run {}. The domain is not served until verify succeeds.",
            crate::step("domain verify")
        ));
        Ok(out)
    }

    /// Verify the bound domain. "The record is not visible yet" is the
    /// ordinary state while DNS propagates, so it is a conflict to wait out
    /// (retryable), not a failure.
    pub async fn domain_verify(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        match self
            .call(
                Method::Post,
                &app_path(&app_id, "/custom-domain/verify"),
                Some(&json!({})),
                None,
                "Verifying the domain (needs admin on the app)",
            )
            .await
        {
            Ok(saved) => {
                self.host.app_changed(row);
                let mut out = domain_view(&saved);
                out["ok"] = json!(true);
                out["action"] = json!("verify");
                out["app_id"] = json!(app_id);
                Ok(out)
            }
            Err(e) if e.kind == ErrorKind::Conflict => Err(OpError {
                message: format!(
                    "{} — DNS changes can take a while to propagate; verify again later. {} with the same domain shows the records to publish.",
                    e.message,
                    crate::step("domain set")
                ),
                retryable: true,
                ..e
            }),
            Err(e) => Err(e),
        }
    }

    pub async fn domain_remove(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        self.del(
            &app_path(&app_id, "/custom-domain"),
            "Unbinding the domain (needs admin on the app)",
        )
        .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "remove",
            "app_id": app_id,
            "note": "The app is still reachable on its own URL.",
        }))
    }

    // ─── data ────────────────────────────────────────────────────────────────

    fn rows_path(app_id: &str, table: &str) -> String {
        app_path(
            app_id,
            &format!("/data/tables/{}/rows", urlencoding::encode(table)),
        )
    }

    pub async fn data_tables(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let out = self
            .get(
                &app_path(&app_id, "/data/tables"),
                "Listing the app's tables (needs write on it)",
            )
            .await?;
        Ok(json!({
            "action": "tables",
            "app_id": app_id,
            "tables": out.get("items").cloned().unwrap_or(json!([])),
        }))
    }

    /// The table's primary-key columns, in order, each with its data type —
    /// read from the app's own catalog rather than guessed.
    async fn data_primary_key(
        &self,
        app_id: &str,
        table: &str,
    ) -> Result<Vec<(String, Option<String>)>, OpError> {
        let tables = self
            .get(
                &app_path(app_id, "/data/tables"),
                "Reading the app's tables",
            )
            .await?;
        let entry = items_of(&tables)
            .into_iter()
            .find(|t| t.get("name").and_then(Value::as_str) == Some(table))
            .ok_or_else(|| {
                OpError::not_found(
                    "no_such_table",
                    format!("No table named {table:?} in this app's database."),
                )
            })?;
        let pk: Vec<String> = entry
            .get("primaryKey")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if pk.is_empty() {
            return Err(OpError::conflict(
                "no_primary_key",
                format!("Table {table:?} has no primary key, so a single row cannot be addressed."),
            ));
        }
        let columns = entry
            .get("columns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(pk
            .into_iter()
            .map(|name| {
                let data_type = columns
                    .iter()
                    .find(|c| c.get("name").and_then(Value::as_str) == Some(name.as_str()))
                    .and_then(|c| c.get("dataType").and_then(Value::as_str))
                    .map(str::to_string);
                (name, data_type)
            })
            .collect())
    }

    pub async fn data_rows(
        &self,
        row: &Value,
        table: &str,
        q: &RowsQuery,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let limit = q.limit.unwrap_or(50).clamp(1, 100);
        let mut query = format!("?limit={limit}");
        if let Some(after) = &q.after {
            query.push_str(&format!("&after={}", urlencoding::encode(after)));
        }
        if let Some(direction) = &q.direction {
            query.push_str(&format!("&direction={}", urlencoding::encode(direction)));
        }
        if let Some((column, op, value)) = &q.filter {
            query.push_str(&format!(
                "&filterColumn={}&filterOp={}",
                urlencoding::encode(column),
                urlencoding::encode(op)
            ));
            if let Some(value) = value {
                query.push_str(&format!("&filterValue={}", urlencoding::encode(value)));
            }
        }
        let out = self
            .get(
                &format!("{}{query}", Self::rows_path(&app_id, table)),
                "Reading the table's rows (needs write on the app)",
            )
            .await?;
        Ok(json!({
            "action": "rows",
            "app_id": app_id,
            "table": table,
            "primary_key": out.get("primaryKey").cloned().unwrap_or(json!([])),
            "editable": out.get("editable").cloned().unwrap_or(json!(false)),
            "rows": out.get("rows").cloned().unwrap_or(json!([])),
            "next_cursor": out.get("nextCursor").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Insert one row. `{}` is a real request — a row of defaults.
    pub async fn data_insert(
        &self,
        row: &Value,
        table: &str,
        values: &Value,
    ) -> Result<Value, OpError> {
        if !values.is_object() {
            return Err(OpError::invalid(
                "invalid_values",
                "values must be an object of column → value ({} inserts defaults)",
            ));
        }
        let app_id = row_id(row)?;
        let out = self
            .post(
                &Self::rows_path(&app_id, table),
                &json!({ "values": values }),
                "Inserting the row (needs admin on the app)",
            )
            .await?;
        Ok(json!({
            "ok": true,
            "action": "insert_row",
            "app_id": app_id,
            "table": table,
            // The row as the database stored it, generated key included.
            "row": out.get("row").cloned().unwrap_or(Value::Null),
        }))
    }

    async fn data_row_path(
        &self,
        app_id: &str,
        table: &str,
        target: &RowRef,
    ) -> Result<String, OpError> {
        let key = match target {
            RowRef::Opaque(opaque) => opaque.clone(),
            RowRef::Key(key) => {
                let columns = self.data_primary_key(app_id, table).await?;
                let pk: Vec<String> = columns.iter().map(|(c, _)| c.clone()).collect();
                data_row_key(&pk, &typed_key(key, &columns))?
            }
        };
        Ok(format!(
            "{}/{}",
            Self::rows_path(app_id, table),
            urlencoding::encode(&key)
        ))
    }

    pub async fn data_update(
        &self,
        row: &Value,
        table: &str,
        target: &RowRef,
        patch: &Value,
    ) -> Result<Value, OpError> {
        if !patch.is_object() {
            return Err(OpError::invalid(
                "invalid_patch",
                "patch must be an object of column → new value",
            ));
        }
        let app_id = row_id(row)?;
        let path = self.data_row_path(&app_id, table, target).await?;
        let out = self
            .patch(
                &path,
                &json!({ "patch": patch }),
                "Updating the row (needs admin on the app)",
            )
            .await?;
        Ok(json!({
            "ok": true,
            "action": "update_row",
            "app_id": app_id,
            "table": table,
            // The row as the database stored it: triggers and defaults may
            // have rewritten what was submitted.
            "row": out.get("row").cloned().unwrap_or(Value::Null),
        }))
    }

    pub async fn data_delete(
        &self,
        row: &Value,
        table: &str,
        target: &RowRef,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let path = self.data_row_path(&app_id, table, target).await?;
        self.del(&path, "Deleting the row (needs admin on the app)")
            .await?;
        Ok(json!({ "ok": true, "action": "delete_row", "app_id": app_id, "table": table }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_value_takes_its_column_s_type() {
        let columns = vec![
            ("sku".to_string(), Some("text".to_string())),
            ("id".to_string(), Some("bigint".to_string())),
        ];
        assert_eq!(
            typed_key(&json!({ "sku": 10023, "id": "42" }), &columns),
            json!({ "sku": "10023", "id": 42 })
        );
        assert_eq!(typed_key(&json!([true, 7]), &columns), json!(["true", 7]));
        // A value that does not fit the type is left for the server to refuse.
        assert_eq!(
            key_value_for_column(&json!("abc"), Some("integer")),
            json!("abc")
        );
        // No catalog type: as given.
        assert_eq!(key_value_for_column(&json!(5), None), json!(5));
    }

    fn members() -> Vec<(String, String)> {
        vec![
            ("m-1".into(), "海港".into()),
            ("m-2".into(), "Wei Gan".into()),
            ("m-3".into(), "wei gan".into()),
        ]
    }

    #[test]
    fn a_name_must_match_exactly_one() {
        assert_eq!(
            pick_by_name(&members(), "海港", "member", "member_id")
                .unwrap()
                .0,
            "m-1"
        );
        // Case-insensitive, so two differing only in case are two matches.
        let e = pick_by_name(&members(), "WEI GAN", "member", "member_id").unwrap_err();
        assert_eq!(e.code, "ambiguous_name");
        assert!(e.contains("matches 2") && e.contains("member_id"), "{e}");
        let e = pick_by_name(&members(), "nobody", "member", "member_id").unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert!(e.contains("Candidates") && e.contains("m-2"), "{e}");
    }

    #[test]
    fn cron_fields_carry_only_what_was_given_in_the_api_s_names() {
        let fields = CronFields {
            name: Some("对账".into()),
            schedule: Some("0 9 * * 1-5".into()),
            timezone: Some("Asia/Shanghai".into()),
            timeout_ms: Some(45000),
            enabled: Some(false),
            headers: Some(json!({ "x-cron-secret": "s" })),
            ..Default::default()
        };
        assert_eq!(
            fields.to_api().unwrap(),
            json!({
                "name": "对账",
                "schedule": "0 9 * * 1-5",
                "timezone": "Asia/Shanghai",
                "timeoutMs": 45000,
                "enabled": false,
                "headers": { "x-cron-secret": "s" },
            })
        );
        assert_eq!(CronFields::default().to_api().unwrap(), json!({}));
        let cleared = CronFields {
            body: Some(None),
            ..Default::default()
        };
        assert!(cleared.to_api().unwrap()["body"].is_null());
    }

    #[test]
    fn cron_headers_must_be_string_values() {
        for headers in [json!({ "x": 1 }), json!(["x"])] {
            let e = CronFields {
                headers: Some(headers),
                ..Default::default()
            }
            .to_api()
            .unwrap_err();
            assert_eq!(e.kind, ErrorKind::Invalid);
        }
    }

    #[test]
    fn row_key_orders_values_by_the_table_s_own_primary_key() {
        use base64::Engine as _;
        let pk = vec!["tenant".to_string(), "id".to_string()];
        // Deliberately supplied in the other order: a composite key silently
        // ordered wrong addresses a DIFFERENT row.
        let encoded = data_row_key(&pk, &json!({ "id": 42, "tenant": "acme" })).unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&encoded)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), r#"["acme",42]"#);
        assert!(data_row_key(&pk, &json!({ "id": 42 }))
            .unwrap_err()
            .contains("tenant"));
        assert!(data_row_key(&pk, &json!([42]))
            .unwrap_err()
            .contains("2 value(s)"));
        // Unpadded, as `appDataRowKey` and `decodeRowKey` agree.
        assert_eq!(
            data_row_key(&["id".to_string()], &json!({ "id": 1 })).unwrap(),
            "WzFd"
        );
    }
}
