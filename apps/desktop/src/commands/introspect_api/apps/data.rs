//! `manage_app_data` — read and edit the rows in a deployed app's own database
//! (the control panel's 线上数据 tab).

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{
    app_path, parse_body, require_action, resolve_app_row, row_id, u64_body_field, AppApi,
};
use crate::commands::introspect_api::{items_of, str_body_field};

const DATA_ACTIONS: [&str; 4] = ["tables", "rows", "update_row", "delete_row"];

/// Opaque row key: unpadded base64url of the JSON array of primary-key values,
/// in the order the table's catalog reports them.
///
/// Mirrors `appDataRowKey` in the frontend and `decodeRowKey` on the server. The
/// agent passes a column → value map and this orders it, because a composite key
/// silently ordered wrong addresses a different row, not an error.
fn encode_app_data_row_key(primary_key: &[String], key: &Value) -> Result<String, String> {
    use base64::Engine as _;
    let values: Vec<Value> = match key {
        Value::Array(a) => {
            if a.len() != primary_key.len() {
                return Err(format!(
                    "key must have {} value(s), in this order: {}",
                    primary_key.len(),
                    primary_key.join(", ")
                ));
            }
            a.clone()
        }
        Value::Object(map) => {
            let mut out = Vec::with_capacity(primary_key.len());
            for column in primary_key {
                let value = map.get(column).ok_or_else(|| {
                    format!(
                        "key is missing primary-key column {column:?} (needs: {})",
                        primary_key.join(", ")
                    )
                })?;
                out.push(value.clone());
            }
            out
        }
        _ => return Err("key must be an object of primary-key columns, or an array".to_string()),
    };
    let json = serde_json::to_string(&values).map_err(|e| format!("cannot encode key: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

/// The table's primary key, read from the app's own catalog rather than guessed.
async fn app_data_primary_key(
    api: &AppApi,
    app_id: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let tables = api
        .get(
            &app_path(app_id, "/data/tables"),
            "Reading the app's tables",
        )
        .await?;
    let entry = items_of(&tables)
        .into_iter()
        .find(|t| t.get("name").and_then(|x| x.as_str()) == Some(table))
        .ok_or_else(|| format!("No table named {table:?} in this app's database."))?;
    let pk: Vec<String> = entry
        .get("primaryKey")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if pk.is_empty() {
        return Err(format!(
            "Table {table:?} has no primary key, so a single row cannot be addressed."
        ));
    }
    Ok(pk)
}

/// `manage_app_data` — read and edit the rows in a deployed app's own database.
///
/// Reads need `prompt` on the app and writes need `admin`; both are the Cloud
/// API's call, not this handler's. Writes address exactly one row by primary
/// key — there is no bulk path on purpose, this is production data.
pub(crate) async fn handle_app_data(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &DATA_ACTIONS)?;
    let api = AppApi::for_tool(app, &v, "manage_app_data").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let app_id = row_id(&row)?;

    if action == "tables" {
        let out = api
            .get(
                &app_path(&app_id, "/data/tables"),
                "Listing the app's tables (needs prompt on it)",
            )
            .await?;
        return Ok(json!({
            "action": "tables",
            "app_id": app_id,
            "tables": out.get("items").cloned().unwrap_or(json!([])),
        })
        .to_string());
    }

    let table = str_body_field(&v, "table", "table").ok_or("Missing field: table")?;
    let enc_table = urlencoding::encode(&table).into_owned();
    let rows_path = app_path(&app_id, &format!("/data/tables/{enc_table}/rows"));

    match action.as_str() {
        "rows" => {
            let limit = u64_body_field(&v, "limit", "limit")
                .unwrap_or(50)
                .clamp(1, 100);
            let mut query = format!("?limit={limit}");
            if let Some(after) = str_body_field(&v, "after", "after") {
                query.push_str(&format!("&after={}", urlencoding::encode(&after)));
            }
            if let Some(direction) = str_body_field(&v, "direction", "direction") {
                query.push_str(&format!("&direction={}", urlencoding::encode(&direction)));
            }
            // All three filter parts or none: the API ignores a value with no
            // column, which reads to an agent as "the filter did nothing".
            let column = str_body_field(&v, "filter_column", "filterColumn");
            let op = str_body_field(&v, "filter_op", "filterOp");
            if let (Some(column), Some(op)) = (column.as_ref(), op.as_ref()) {
                query.push_str(&format!(
                    "&filterColumn={}&filterOp={}",
                    urlencoding::encode(column),
                    urlencoding::encode(op)
                ));
                if let Some(value) = str_body_field(&v, "filter_value", "filterValue") {
                    query.push_str(&format!("&filterValue={}", urlencoding::encode(&value)));
                }
            } else if column.is_some() != op.is_some() {
                return Err(
                    "filter_column and filter_op must be given together (ops: eq, contains, isNull, notNull)"
                        .to_string(),
                );
            }
            let out = api
                .get(
                    &format!("{rows_path}{query}"),
                    "Reading the table's rows (needs prompt on the app)",
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
            })
            .to_string())
        }
        "update_row" | "delete_row" => {
            let row_key = match str_body_field(&v, "row_key", "rowKey") {
                Some(opaque) => opaque,
                None => {
                    let key = v
                        .get("key")
                        .ok_or("Missing field: key (the row's primary-key columns)")?;
                    let pk = app_data_primary_key(&api, &app_id, &table).await?;
                    encode_app_data_row_key(&pk, key)?
                }
            };
            let path = format!("{rows_path}/{}", urlencoding::encode(&row_key));
            if action == "delete_row" {
                api.delete(&path, "Deleting the row (needs admin on the app)")
                    .await?;
                return Ok(json!({
                    "ok": true, "action": "delete_row",
                    "app_id": app_id, "table": table,
                })
                .to_string());
            }
            let patch = v
                .get("patch")
                .filter(|p| p.is_object())
                .ok_or("Missing field: patch (an object of column → new value)")?;
            let out = api
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
            })
            .to_string())
        }
        other => Err(format!("Unknown action: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_key_orders_values_by_the_table_s_own_primary_key() {
        use base64::Engine as _;
        let pk = vec!["tenant".to_string(), "id".to_string()];
        // Deliberately supplied in the other order: a composite key silently
        // ordered wrong addresses a DIFFERENT row, which is not an error the
        // caller would ever see.
        let key = json!({ "id": 42, "tenant": "acme" });
        let encoded = encode_app_data_row_key(&pk, &key).unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&encoded)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), r#"["acme",42]"#);
    }

    #[test]
    fn row_key_refuses_a_half_specified_composite_key() {
        let pk = vec!["tenant".to_string(), "id".to_string()];
        let err = encode_app_data_row_key(&pk, &json!({ "id": 42 })).unwrap_err();
        assert!(err.contains("tenant"), "{err}");

        let err = encode_app_data_row_key(&pk, &json!([42])).unwrap_err();
        assert!(err.contains("2 value(s)"), "{err}");
    }

    #[test]
    fn row_key_matches_what_the_frontend_and_the_server_agree_on() {
        // `appDataRowKey` in the web app and `decodeRowKey` in the Cloud API
        // both use unpadded base64url of the JSON array. Padding here would be
        // a 400 from the server, only for keys whose length lands wrong.
        let pk = vec!["id".to_string()];
        assert_eq!(
            encode_app_data_row_key(&pk, &json!({ "id": 1 })).unwrap(),
            "WzFd",
        );
    }
}
