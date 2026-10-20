import { ApiError } from "./http-utils.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      lastMessageAt: optionalStringOrNull(parsed.lastMessageAt, "cursor.lastMessageAt"),
      createdAt: optionalStringOrNull(parsed.createdAt, "cursor.createdAt"),
      id: optionalStringOrNull(parsed.id, "cursor.id"),
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

export function nextSessionCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    lastMessageAt: last.lastMessageAt ?? null,
    createdAt: last.createdAt ?? null,
    id: last.id,
  });
}

// Sync pagination uses its own cursor shape. The session-list cursor above is
// keyed on (lastMessageAt, createdAt, id) to match that endpoint's ordering;
// sync walks forward through (updatedAt, id) instead, because its whole
// contract is "everything changed since X" and updatedAt is the only column
// that moves monotonically as rows are touched.
export function decodeSyncCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      updatedAt: optionalStringOrNull(parsed.updatedAt, "cursor.updatedAt"),
      id: optionalStringOrNull(parsed.id, "cursor.id"),
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

export function nextSyncCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    updatedAt: last.updated_at ?? last.updatedAt ?? null,
    id: last.id,
  });
}

// Message history has its own limits because its page is a chat viewport, not a
// list row: 200 is roughly what a client renders on open, where 50 would force
// an immediate second round-trip. Before this existed the endpoint had no limit
// at all and returned the whole history — 6k messages measured 6.1s / 3.7MB, 20k
// took 22.9s, and 40k exceeded the 8s statement_timeout and 500'd.
export const DEFAULT_MESSAGE_LIST_LIMIT = 200;
export const MAX_MESSAGE_LIST_LIMIT = 500;

// A message page walks BACKWARD from the newest message, because that is what a
// chat opens on: the first page is the tail of the history, and `nextCursor`
// reaches further into the past. Items inside a page stay oldest-first so
// clients can keep rendering them in order.
export function decodeMessageCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      createdAt: optionalStringOrNull(parsed.createdAt, "cursor.createdAt"),
      id: optionalStringOrNull(parsed.id, "cursor.id"),
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

// The cursor points at the OLDEST row on the page (items[0]) — that is the
// boundary the next, older page continues from.
export function nextMessageCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const oldest = items[0];
  if (!oldest) return null;
  return encodeCursor({
    createdAt: oldest.createdAt ?? oldest.created_at ?? null,
    id: oldest.id,
  });
}

export function parseMessageLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_MESSAGE_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_LIST_LIMIT) {
    throw new ApiError(
      400,
      "validation_failed",
      `limit must be an integer from 1 to ${MAX_MESSAGE_LIST_LIMIT}`,
    );
  }
  return limit;
}

export function parseLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 100");
  }
  return limit;
}

export function decodeSessionAttachmentCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      attachedAt: optionalStringOrNull(parsed.attachedAt, "cursor.attachedAt"),
      storagePath: optionalStringOrNull(parsed.storagePath, "cursor.storagePath"),
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

export function encodeSessionAttachmentCursor(cursor) {
  return encodeCursor({
    attachedAt: cursor.attachedAt,
    storagePath: cursor.storagePath,
  });
}

export function nextSessionAttachmentCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last?.attachedAt || !last?.storagePath) return null;
  return encodeSessionAttachmentCursor({
    attachedAt: last.attachedAt,
    storagePath: last.storagePath,
  });
}

export function queryParams(event) {
  const params = new URLSearchParams();
  // FC 2.0 uses queryStringParameters; FC 3.0 uses queryParameters. Some events
  // carry an empty queryStringParameters object alongside populated queryParameters.
  for (const source of [event.queryStringParameters, event.queryParameters]) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
  }
  let raw = event.rawQueryString ?? event.queryString ?? "";
  if (!raw) {
    const pathStr = event.rawPath ?? event.path ?? "";
    const qIdx = pathStr.indexOf("?");
    if (qIdx >= 0) raw = pathStr.slice(qIdx + 1);
  }
  if (raw) {
    for (const [key, value] of new URLSearchParams(raw)) {
      params.set(key, value);
    }
  }
  return params;
}

export function normalizePath(path) {
  const withoutQuery = path.split("?")[0];
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

export function requireString(value, field) {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new ApiError(400, "validation_failed", `${field} is required`);
}

export function optionalStringOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ApiError(400, "validation_failed", `${field} must be a string or null`);
}
