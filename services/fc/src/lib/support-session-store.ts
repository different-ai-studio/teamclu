import { ApiError } from "./http-utils.js";
import {
  allowSupportSession,
  concludeSupportSession,
  closeSupportSession,
  createSupportSessionRow,
  formatSupportCode,
  generateSupportCode,
  helperView,
  isSupportPhase,
  normalizeSupportCode,
  redeemSupportSession,
  supportDisplayName,
  supportView,
  uploadSupportBundle,
  withExpiry,
  type SupportCaller,
  type SupportSession,
} from "./support-session.js";

function fromDb(row: any): SupportSession {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    phase: row.phase,
    supportUserId: row.support_user_id ?? null,
    supportDisplayName: row.support_display_name ?? null,
    bundle: row.bundle ?? null,
    conclusion: row.conclusion ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function toDb(row: SupportSession) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    phase: row.phase,
    support_user_id: row.supportUserId,
    support_display_name: row.supportDisplayName,
    bundle: row.bundle,
    conclusion: row.conclusion,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  };
}

async function persist(admin: any, row: SupportSession, expectStatus?: string): Promise<SupportSession | null> {
  let query = admin.from("support_sessions").update(toDb(row)).eq("id", row.id);
  if (expectStatus) query = query.eq("status", expectStatus);
  const { data, error } = await query.select("*");
  if (error) throw error;
  const saved = Array.isArray(data) ? data[0] : data;
  return saved ? fromDb(saved) : null;
}

export function supportSessionMethods(deps: { admin: () => Promise<any> }) {
  async function client() {
    return deps.admin();
  }

  async function load(admin: any, id: string, now: Date): Promise<SupportSession> {
    const { data, error } = await admin.from("support_sessions").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "not_found", "support session not found");
    const row = withExpiry(fromDb(data), now);
    if (row.status !== data.status) {
      const saved = await persist(admin, row, data.status);
      return saved ?? row;
    }
    return row;
  }

  async function findByCode(admin: any, code: unknown, now: Date): Promise<SupportSession> {
    const normalized = normalizeSupportCode(String(code ?? ""));
    if (normalized.length !== 8) throw new ApiError(404, "not_found", "support session not found");
    const { data, error } = await admin
      .from("support_sessions")
      .select("*")
      .eq("code", normalized)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "not_found", "support session not found");
    return load(admin, data.id, now);
  }

  function requireCode(code: string | null | undefined): string {
    const normalized = normalizeSupportCode(code ?? "");
    if (normalized.length !== 8) throw new ApiError(404, "not_found", "support session not found");
    return normalized;
  }

  async function resolveCaller(admin: any, bearer: string | null): Promise<SupportCaller> {
    if (!bearer) throw new ApiError(401, "missing_auth", "Missing Authorization bearer token");
    const { data, error } = await admin.auth.getUser(bearer);
    const user = data?.user;
    if (error || !user?.id) throw new ApiError(401, "unauthorized", "no authenticated user");
    let nickname: string | null = null;
    let email: string | null = typeof user.email === "string" ? user.email : null;
    const lookup = await admin.schema("public").from("users").select("nickname, email").eq("auth_user_id", user.id);
    if (!lookup.error && Array.isArray(lookup.data)) {
      for (const row of lookup.data) {
        const nick = typeof row.nickname === "string" ? row.nickname.trim() : "";
        if (nick && !nickname) nickname = nick;
        if (!email && typeof row.email === "string" && row.email.trim()) email = row.email.trim();
      }
    }
    return { id: user.id, nickname, email };
  }

  return {
    async createSupportSession(body: { phase?: unknown }) {
      if (!isSupportPhase(body?.phase)) {
        throw new ApiError(400, "validation_failed", "phase must be install, webview, or manual");
      }
      const admin = await client();
      const now = new Date();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const row = createSupportSessionRow({ phase: body.phase, code: generateSupportCode(), now });
        const { error } = await admin.from("support_sessions").insert(toDb(row));
        if (!error) {
          return { sessionId: row.id, code: formatSupportCode(row.code), expiresAt: row.expiresAt };
        }
        if (error.code !== "23505") throw error;
      }
      throw new ApiError(500, "internal", "could not allocate a support code");
    },

    async getSupportSession(id: string, access: { code?: string | null; bearer?: string | null }) {
      const admin = await client();
      const row = await load(admin, id, new Date());
      if (access.code) {
        if (row.code !== requireCode(access.code)) {
          throw new ApiError(404, "not_found", "support session not found");
        }
        return helperView(row);
      }
      const caller = await resolveCaller(admin, access.bearer ?? null);
      if (!row.supportUserId || row.supportUserId !== caller.id) {
        throw new ApiError(404, "not_found", "support session not found");
      }
      return supportView(row);
    },

    async redeemSupportSession(code: unknown, bearer: string | null) {
      const admin = await client();
      const now = new Date();
      const caller = await resolveCaller(admin, bearer);
      const current = await findByCode(admin, code, now);
      const next = redeemSupportSession(current, caller, now);
      const saved = await persist(admin, next, "waiting");
      if (!saved) {
        const again = await load(admin, current.id, now);
        if (again.status === "expired") throw new ApiError(410, "expired", "support session expired");
        throw new ApiError(409, "already_redeemed", "support session already redeemed");
      }
      return { sessionId: saved.id, phase: saved.phase, status: saved.status };
    },

    async allowSupportSession(id: string, code: string | null) {
      const admin = await client();
      const now = new Date();
      const row = await load(admin, id, now);
      if (row.code !== requireCode(code)) throw new ApiError(404, "not_found", "support session not found");
      const next = allowSupportSession(row, now);
      const saved = await persist(admin, next, "redeemed");
      if (!saved) throw new ApiError(409, "not_redeemed", "support session is not redeemed");
      return { status: saved.status };
    },

    async uploadSupportBundle(id: string, code: string | null, bundle: unknown) {
      const admin = await client();
      const now = new Date();
      const row = await load(admin, id, now);
      if (row.code !== requireCode(code)) throw new ApiError(404, "not_found", "support session not found");
      const next = uploadSupportBundle(row, bundle, now);
      const saved = await persist(admin, next, "allowed");
      if (!saved) {
        const again = await load(admin, id, now);
        if (again.bundle != null) throw new ApiError(409, "already_uploaded", "support bundle already uploaded");
        throw new ApiError(409, "not_allowed", "support session is not allowed");
      }
      return { status: saved.status };
    },

    async concludeSupportSession(id: string, bearer: string | null, text: unknown) {
      const admin = await client();
      const now = new Date();
      const caller = await resolveCaller(admin, bearer);
      const row = await load(admin, id, now);
      if (!row.supportUserId || row.supportUserId !== caller.id) {
        throw new ApiError(404, "not_found", "support session not found");
      }
      if (typeof text !== "string") throw new ApiError(400, "validation_failed", "conclusion is required");
      const next = concludeSupportSession(row, text, now);
      const saved = await persist(admin, next, "allowed");
      if (!saved) throw new ApiError(409, "not_allowed", "support session is not allowed");
      return { status: saved.status };
    },

    async closeSupportSession(
      id: string,
      access: { code?: string | null; bearer?: string | null },
      reason: unknown,
    ) {
      const admin = await client();
      const now = new Date();
      const row = await load(admin, id, now);
      if (access.code) {
        if (row.code !== requireCode(access.code)) {
          throw new ApiError(404, "not_found", "support session not found");
        }
      } else {
        const caller = await resolveCaller(admin, access.bearer ?? null);
        if (!row.supportUserId || row.supportUserId !== caller.id) {
          throw new ApiError(404, "not_found", "support session not found");
        }
      }
      const next = closeSupportSession(row, String(reason ?? ""), now);
      if (next.status === row.status && next.conclusion === row.conclusion) return { status: next.status };
      const saved = await persist(admin, next, row.status);
      return { status: saved?.status ?? next.status };
    },
  };
}

export { supportDisplayName };
