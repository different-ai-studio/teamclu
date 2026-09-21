"use strict";

const { SYNC_OPTIONS } = require("./publish");

function toCamelSyncBody(options = SYNC_OPTIONS) {
  return {
    forceSync: Boolean(options.force_sync),
    allowBulkAdd: Boolean(options.allow_bulk_add),
    allowBulkDelete: Boolean(options.allow_bulk_delete),
  };
}

function createDaemonSync({ baseUrl, token, fetchImpl = fetch }) {
  if (!baseUrl) {
    return null;
  }
  return async function syncTeam(options = SYNC_OPTIONS) {
    const body = toCamelSyncBody(options);
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/v1/team/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: payload.error || `daemon sync HTTP ${response.status}`, ...payload };
    }
    return { ok: true, ...payload };
  };
}

module.exports = { createDaemonSync, toCamelSyncBody };
