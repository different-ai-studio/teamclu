import { randomInt, randomUUID } from "node:crypto";
import { ApiError } from "./http-utils.js";

export const SUPPORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SUPPORT_SESSION_TTL_MS = 15 * 60 * 1000;
export const SUPPORT_CONCLUSION_MAX_CHARS = 4000;
export const SUPPORT_LOG_TAIL_MAX_BYTES = 256 * 1024;
export const SUPPORT_BUNDLE_MAX_BYTES = 1024 * 1024;

export type SupportPhase = "install" | "webview" | "manual";
export type SupportStatus =
  | "waiting"
  | "redeemed"
  | "allowed"
  | "concluded"
  | "rejected"
  | "closed"
  | "expired";

export interface SupportCaller {
  id: string;
  nickname?: string | null;
  email?: string | null;
}

export interface SupportSession {
  id: string;
  code: string;
  status: SupportStatus;
  phase: SupportPhase;
  supportUserId: string | null;
  supportDisplayName: string | null;
  bundle: unknown | null;
  conclusion: string | null;
  createdAt: string;
  expiresAt: string;
}

const OPENABLE = new Set<SupportStatus>(["waiting", "redeemed", "allowed"]);

export function normalizeSupportCode(input: string): string {
  return input.replace(/-/g, "").trim().toUpperCase();
}

export function formatSupportCode(code: string): string {
  const normalized = normalizeSupportCode(code);
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

export function generateSupportCode(nextByte: () => number = () => randomInt(256)): string {
  let out = "";
  while (out.length < 8) {
    out += SUPPORT_CODE_ALPHABET[nextByte() % SUPPORT_CODE_ALPHABET.length];
  }
  return out;
}

export function supportDisplayName(
  nickname: string | null | undefined,
  email: string | null | undefined,
): string {
  const nick = nickname?.trim();
  if (nick) return nick;
  const mail = email?.trim();
  if (mail) return mail;
  return "支持人员";
}

export function isSupportPhase(value: unknown): value is SupportPhase {
  return value === "install" || value === "webview" || value === "manual";
}

export function withExpiry(row: SupportSession, now: Date): SupportSession {
  if (!OPENABLE.has(row.status)) return row;
  if (new Date(row.expiresAt).getTime() > now.getTime()) return row;
  return { ...row, status: "expired" };
}

function expired(row: SupportSession): never {
  throw new ApiError(410, "expired", "support session expired");
}

export function createSupportSessionRow(input: {
  phase: SupportPhase;
  code: string;
  now: Date;
  id?: string;
}): SupportSession {
  const createdAt = input.now.toISOString();
  return {
    id: input.id ?? randomUUID(),
    code: normalizeSupportCode(input.code),
    status: "waiting",
    phase: input.phase,
    supportUserId: null,
    supportDisplayName: null,
    bundle: null,
    conclusion: null,
    createdAt,
    expiresAt: new Date(input.now.getTime() + SUPPORT_SESSION_TTL_MS).toISOString(),
  };
}

export function redeemSupportSession(
  row: SupportSession,
  caller: SupportCaller,
  now: Date,
): SupportSession {
  const current = withExpiry(row, now);
  if (current.status === "expired") expired(current);
  if (current.status !== "waiting") {
    throw new ApiError(409, "already_redeemed", "support session already redeemed");
  }
  return {
    ...current,
    status: "redeemed",
    supportUserId: caller.id,
    supportDisplayName: supportDisplayName(caller.nickname, caller.email),
  };
}

export function allowSupportSession(row: SupportSession, now: Date): SupportSession {
  const current = withExpiry(row, now);
  if (current.status === "expired") expired(current);
  if (current.status !== "redeemed") {
    throw new ApiError(409, "not_redeemed", "support session is not redeemed");
  }
  return { ...current, status: "allowed" };
}

export function assertSupportBundle(bundle: unknown): void {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new ApiError(400, "validation_failed", "bundle must be an object");
  }
  const encoded = Buffer.byteLength(JSON.stringify(bundle), "utf8");
  if (encoded > SUPPORT_BUNDLE_MAX_BYTES) {
    throw new ApiError(400, "validation_failed", "bundle is too large");
  }
  const logs = (bundle as { logs?: unknown }).logs;
  if (logs !== undefined && !Array.isArray(logs)) {
    throw new ApiError(400, "validation_failed", "bundle.logs must be an array");
  }
  for (const entry of logs ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const tail = (entry as { tail?: unknown }).tail;
    if (typeof tail !== "string") continue;
    if (Buffer.byteLength(tail, "utf8") > SUPPORT_LOG_TAIL_MAX_BYTES) {
      throw new ApiError(400, "validation_failed", "log tail is too large");
    }
  }
}

export function uploadSupportBundle(
  row: SupportSession,
  bundle: unknown,
  now: Date,
): SupportSession {
  const current = withExpiry(row, now);
  if (current.status === "expired") expired(current);
  if (current.status !== "allowed") {
    throw new ApiError(409, "not_allowed", "support session is not allowed");
  }
  if (current.bundle != null) {
    throw new ApiError(409, "already_uploaded", "support bundle already uploaded");
  }
  assertSupportBundle(bundle);
  return { ...current, bundle };
}

export function concludeSupportSession(
  row: SupportSession,
  text: string,
  now: Date,
): SupportSession {
  const current = withExpiry(row, now);
  if (current.status === "expired") expired(current);
  if (current.status === "concluded" || current.status === "closed" || current.status === "rejected") {
    throw new ApiError(409, "closed", "support session is closed");
  }
  if (current.status !== "allowed") {
    throw new ApiError(409, "not_allowed", "support session is not allowed");
  }
  if (text.length > SUPPORT_CONCLUSION_MAX_CHARS) {
    throw new ApiError(400, "validation_failed", "conclusion is too long");
  }
  const trimmed = text.trim();
  if (!trimmed) throw new ApiError(400, "validation_failed", "conclusion is required");
  return { ...current, status: "concluded", conclusion: trimmed };
}

export function closeSupportSession(
  row: SupportSession,
  reason: string,
  now: Date,
): SupportSession {
  const current = withExpiry(row, now);
  if (current.status === "rejected" || current.status === "closed" || current.status === "expired") {
    return current;
  }
  if (current.status === "concluded") return { ...current, status: "closed" };
  if (reason === "user_rejected") return { ...current, status: "rejected" };
  if (reason === "user_closed" || reason === "support_closed") {
    return { ...current, status: "closed" };
  }
  throw new ApiError(400, "validation_failed", "invalid close reason");
}

export function helperView(row: SupportSession) {
  return {
    status: row.status,
    supportDisplayName: row.supportDisplayName,
    conclusion: row.conclusion,
    expiresAt: row.expiresAt,
  };
}

export function supportView(row: SupportSession) {
  return {
    sessionId: row.id,
    status: row.status,
    phase: row.phase,
    supportDisplayName: row.supportDisplayName,
    bundle: row.bundle,
    conclusion: row.conclusion,
    expiresAt: row.expiresAt,
  };
}

export interface SupportSessionStore {
  setNow(now: () => Date): void;
  bindBearer(token: string, caller: SupportCaller): void;
  createSupportSession(body: { phase?: unknown }): Promise<{ sessionId: string; code: string; expiresAt: string }>;
  getSupportSession(id: string, access: { code?: string | null; bearer?: string | null }): Promise<Record<string, unknown>>;
  redeemSupportSession(code: unknown, bearer: string | null): Promise<{ sessionId: string; phase: SupportPhase; status: SupportStatus }>;
  allowSupportSession(id: string, code: string | null): Promise<{ status: SupportStatus }>;
  uploadSupportBundle(id: string, code: string | null, bundle: unknown): Promise<{ status: SupportStatus }>;
  concludeSupportSession(id: string, bearer: string | null, text: unknown): Promise<{ status: SupportStatus }>;
  closeSupportSession(
    id: string,
    access: { code?: string | null; bearer?: string | null },
    reason: unknown,
  ): Promise<{ status: SupportStatus }>;
}

export function createMemorySupportSessions(): SupportSessionStore {
  const byId = new Map<string, SupportSession>();
  const bearers = new Map<string, SupportCaller>();
  let now = () => new Date();

  function requireCode(code: string | null | undefined): string {
    const normalized = normalizeSupportCode(code ?? "");
    if (normalized.length !== 8) throw new ApiError(404, "not_found", "support session not found");
    return normalized;
  }

  function callerFor(bearer: string | null): SupportCaller {
    if (!bearer) throw new ApiError(401, "missing_auth", "Missing Authorization bearer token");
    const caller = bearers.get(bearer);
    if (!caller) throw new ApiError(401, "unauthorized", "no authenticated user");
    return caller;
  }

  async function load(id: string): Promise<SupportSession> {
    const row = byId.get(id);
    if (!row) throw new ApiError(404, "not_found", "support session not found");
    const next = withExpiry(row, now());
    if (next !== row) byId.set(id, next);
    return next;
  }

  function byCode(code: string): SupportSession | undefined {
    const normalized = requireCode(code);
    for (const row of byId.values()) {
      if (row.code === normalized) return withExpiry(row, now());
    }
    return undefined;
  }

  return {
    setNow(fn) {
      now = fn;
    },
    bindBearer(token, caller) {
      bearers.set(token, caller);
    },
    async createSupportSession(body) {
      if (!isSupportPhase(body?.phase)) {
        throw new ApiError(400, "validation_failed", "phase must be install, webview, or manual");
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = generateSupportCode();
        if ([...byId.values()].some((row) => row.code === code)) continue;
        const row = createSupportSessionRow({ phase: body.phase, code, now: now() });
        byId.set(row.id, row);
        return { sessionId: row.id, code: formatSupportCode(row.code), expiresAt: row.expiresAt };
      }
      throw new ApiError(500, "internal", "could not allocate a support code");
    },
    async getSupportSession(id, access) {
      const row = await load(id);
      if (access.code) {
        if (row.code !== requireCode(access.code)) {
          throw new ApiError(404, "not_found", "support session not found");
        }
        return helperView(row);
      }
      const caller = callerFor(access.bearer ?? null);
      if (!row.supportUserId || row.supportUserId !== caller.id) {
        throw new ApiError(404, "not_found", "support session not found");
      }
      return supportView(row);
    },
    async redeemSupportSession(code, bearer) {
      const caller = callerFor(bearer);
      const found = byCode(String(code ?? ""));
      if (!found) throw new ApiError(404, "not_found", "support session not found");
      const current = await load(found.id);
      const next = redeemSupportSession(current, caller, now());
      byId.set(next.id, next);
      return { sessionId: next.id, phase: next.phase, status: next.status };
    },
    async allowSupportSession(id, code) {
      const row = await load(id);
      if (row.code !== requireCode(code)) throw new ApiError(404, "not_found", "support session not found");
      const next = allowSupportSession(row, now());
      byId.set(next.id, next);
      return { status: next.status };
    },
    async uploadSupportBundle(id, code, bundle) {
      const row = await load(id);
      if (row.code !== requireCode(code)) throw new ApiError(404, "not_found", "support session not found");
      const next = uploadSupportBundle(row, bundle, now());
      byId.set(next.id, next);
      return { status: next.status };
    },
    async concludeSupportSession(id, bearer, text) {
      const caller = callerFor(bearer);
      const row = await load(id);
      if (!row.supportUserId || row.supportUserId !== caller.id) {
        throw new ApiError(404, "not_found", "support session not found");
      }
      if (typeof text !== "string") throw new ApiError(400, "validation_failed", "conclusion is required");
      const next = concludeSupportSession(row, text, now());
      byId.set(next.id, next);
      return { status: next.status };
    },
    async closeSupportSession(id, access, reason) {
      const row = await load(id);
      if (access.code) {
        if (row.code !== requireCode(access.code)) {
          throw new ApiError(404, "not_found", "support session not found");
        }
        if (reason !== "user_rejected" && reason !== "user_closed") {
          throw new ApiError(400, "validation_failed", "invalid close reason");
        }
      } else {
        const caller = callerFor(access.bearer ?? null);
        if (!row.supportUserId || row.supportUserId !== caller.id) {
          throw new ApiError(404, "not_found", "support session not found");
        }
        if (reason !== "support_closed") {
          throw new ApiError(400, "validation_failed", "invalid close reason");
        }
      }
      const next = closeSupportSession(row, String(reason), now());
      byId.set(next.id, next);
      return { status: next.status };
    },
  };
}
