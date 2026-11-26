//! `manage_app_data` — read and edit the rows in a deployed app's own database
//! (the control panel's 线上数据 tab). The flows are `teamclu-apps`
//! (`resources.rs`), shared with `amuxd app data`.

use serde_json::Value;
use tauri::AppHandle;
use teamclu_apps::{RowRef, RowsQuery};

use super::{
    app_ops, parse_body, require_action, resolve_app_row, u64_body_field, AppApi, DesktopHost,
};
use crate::commands::introspect_api::str_body_field;

const DATA_ACTIONS: [&str; 5] = ["tables", "rows", "insert_row", "update_row", "delete_row"];

/// The row an update or delete addresses: `row_key` as given, or `key` (its
/// primary-key columns), which the flow orders by the table's catalog.
fn row_ref(v: &Value) -> Result<RowRef, String> {
    if let Some(opaque) = str_body_field(v, "row_key", "rowKey") {
        return Ok(RowRef::Opaque(opaque));
    }
    v.get("key")
        .cloned()
        .map(RowRef::Key)
        .ok_or_else(|| "Missing field: key (the row's primary-key columns)".to_string())
}

/// `manage_app_data` — read and edit the rows in a deployed app's own database.
///
/// Reads need `write` on the app and writes need `admin`; both are the Cloud
/// API's call. Writes touch exactly one row — there is no bulk path on
/// purpose, this is production data.
pub(crate) async fn handle_app_data(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &DATA_ACTIONS)?;
    let api = AppApi::for_tool(app, &v, "manage_app_data").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let host = DesktopHost::new(app, &api);
    let ops = app_ops(&api, &host);

    if action == "tables" {
        return Ok(ops.data_tables(&row).await?.to_string());
    }
    let table = str_body_field(&v, "table", "table").ok_or("Missing field: table")?;
    let out = match action.as_str() {
        "rows" => {
            // All three filter parts or none: the API ignores a value with no
            // column, which reads to an agent as "the filter did nothing".
            let column = str_body_field(&v, "filter_column", "filterColumn");
            let op = str_body_field(&v, "filter_op", "filterOp");
            let filter = match (column, op) {
                (Some(column), Some(op)) => {
                    Some((column, op, str_body_field(&v, "filter_value", "filterValue")))
                }
                (None, None) => None,
                _ => {
                    return Err(
                        "filter_column and filter_op must be given together (ops: eq, contains, isNull, notNull)"
                            .to_string(),
                    )
                }
            };
            let q = RowsQuery {
                limit: u64_body_field(&v, "limit", "limit"),
                after: str_body_field(&v, "after", "after"),
                direction: str_body_field(&v, "direction", "direction"),
                filter,
            };
            ops.data_rows(&row, &table, &q).await?
        }
        "insert_row" => {
            let values = v.get("values").filter(|p| p.is_object()).ok_or(
                "Missing field: values (an object of column → value; {} inserts defaults)",
            )?;
            ops.data_insert(&row, &table, values).await?
        }
        "update_row" => {
            let target = row_ref(&v)?;
            let patch = v
                .get("patch")
                .filter(|p| p.is_object())
                .ok_or("Missing field: patch (an object of column → new value)")?;
            ops.data_update(&row, &table, &target, patch).await?
        }
        "delete_row" => ops.data_delete(&row, &table, &row_ref(&v)?).await?,
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}
