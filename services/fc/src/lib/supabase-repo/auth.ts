// Supabase auth repository (GoTrue-backed sign-in / OAuth / invite claim),
// extracted from supabase-repo.ts. Self-contained: its own anon client and
// per-token client, independent of the business repository's bearer client.
import { createClient as defaultCreateClient } from "@supabase/supabase-js";

import { ApiError } from "../http-utils.js";
import { createPhoneAuthRepository } from "./phone-auth.js";
import { makeDysmsSender } from "../sms.js";

import { REALTIME_TRANSPORT_OPTS, requiredRow, requiredString, requiredInteger } from "./shared.js";
import { assignSystemOrgRole } from "./org-roles.js";

// Both pending-invite RPCs guard by visibility: an invite not addressed to the
// caller's verified contact raises 23503 exactly like a nonexistent id, so a
// caller cannot distinguish "not yours" from "not there" — 404 for both.
function mapPendingInviteError(error, fallback: string) {
  const code = error?.code || "";
  const msg = error?.message ?? fallback;
  if (code === "23503") return new ApiError(404, "not_found", msg);
  if (code === "23505") return new ApiError(409, "conflict", msg);
  if (code === "23514") return new ApiError(409, "conflict", msg);
  if (code === "42501") return new ApiError(401, "unauthorized", msg);
  return new ApiError(400, "validation_failed", msg);
}

export function createSupabaseAuthRepository(options) {
  const {
    supabaseUrl,
    // Browser-facing GoTrue base for OAuth redirects. Falls back to supabaseUrl.
    // Must be publicly reachable: supabaseUrl is often an internal/VPC address
    // (fast for server-to-server calls) that a user's browser cannot reach, so
    // the OAuth `authorize` redirect needs a public URL instead.
    supabasePublicUrl = supabaseUrl,
    publishableKey,
    fetchImpl = globalThis.fetch,
    createClient = defaultCreateClient,
    // Phone-auth (partner-aligned) config. Optional: phone login is only enabled
    // when serviceRoleKey + defaultOrgId + phoneEmailDomain + encryptionKey are
    // present. The repo is built lazily so environments/tests lacking these
    // still construct fine.
    serviceRoleKey = undefined,
    defaultOrgId = undefined,
    phoneEmailDomain = undefined,
    phoneAuthEncryptionKey = undefined,
    smsDebugMode = false,
    sendSms = undefined,
    verifyCaptcha = undefined,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");

  let _phoneRepo: ReturnType<typeof createPhoneAuthRepository> | null = null;
  function phoneRepo() {
    if (_phoneRepo) return _phoneRepo;
    if (!serviceRoleKey || !defaultOrgId || !phoneEmailDomain || !phoneAuthEncryptionKey) {
      throw new ApiError(
        501,
        "not_implemented",
        "phone login is not configured (needs SUPABASE_SERVICE_ROLE_KEY, DEFAULT_ORG_ID, PHONE_EMAIL_DOMAIN, PHONE_AUTH_ENCRYPTION_KEY)",
      );
    }
    _phoneRepo = createPhoneAuthRepository({
      supabaseUrl,
      publishableKey,
      serviceRoleKey,
      defaultOrgId,
      phoneEmailDomain,
      encryptionKey: phoneAuthEncryptionKey,
      smsDebugMode,
      sendSms: sendSms ?? makeDysmsSender({ createClient, supabaseUrl, serviceRoleKey }),
      verifyCaptcha,
      createClient,
    });
    return _phoneRepo;
  }

  // Anonymous Supabase client (no Authorization header). Used for the
  // `claim_team_invite` SECURITY DEFINER RPC which the daemon must call
  // before it owns any auth token.
  const anonClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "amux" }, realtime: REALTIME_TRANSPORT_OPTS,
  });

  // Build a Supabase client authorized as the caller, so the SECURITY DEFINER
  // RPC sees `auth.uid()` (required for `kind='member'` claims). Lazily created
  // per access token; the daemon's agent-claim flow has no token and reuses the
  // shared anonClient.
  function clientForToken(accessToken) {
    if (!accessToken) return anonClient;
    return createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "amux" }, realtime: REALTIME_TRANSPORT_OPTS,
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  return {
    // ctx.accessToken (optional): the joining user's bearer. Forwarded so the
    // `claim_team_invite` RPC resolves `auth.uid()` for member invites. Absent
    // for agent invites (daemon `amuxd init`), which the RPC self-provisions.
    async claimInvite(token, ctx: { accessToken?: string } = {}) {
      const client = clientForToken(ctx.accessToken);
      const { data, error } = await client.rpc("claim_team_invite", { p_token: token });
      if (error) {
        const msg = error.message || "claim_team_invite failed";
        const lower = msg.toLowerCase();
        if (lower.includes("not found") || lower.includes("invite invalid") || lower.includes("invalid invite")) {
          throw new ApiError(404, "not_found", `invite invalid or expired: ${msg}`);
        }
        if (lower.includes("already claimed") || lower.includes("claimed")) {
          throw new ApiError(409, "conflict", `invite already claimed: ${msg}`);
        }
        throw new ApiError(400, "validation_failed", msg);
      }
      const row = requiredRow(data, "auth.claimInvite");
      const result = {
        actorId: requiredString(row.actor_id, "auth.claimInvite", "actor_id"),
        teamId: requiredString(row.team_id, "auth.claimInvite", "team_id"),
        actorType: requiredString(row.actor_type, "auth.claimInvite", "actor_type"),
        displayName: requiredString(row.display_name, "auth.claimInvite", "display_name"),
        refreshToken: row.refresh_token ?? null,
      };
      // Member invites: write roles_users (authz SoT). Agents have no public.users row.
      if (result.actorType === "member" && ctx.accessToken) {
        const { data: userData } = await client.auth.getUser();
        const userId = userData?.user?.id;
        if (userId) {
          await assignSystemOrgRole(client, {
            teamId: result.teamId,
            userId,
            code: "member",
          });
        }
      }
      return result;
    },

    // Invites addressed to the caller's verified email/phone. Lives here rather
    // than in the business repository because the RPC keys off `auth.uid()`, so
    // it needs the caller's bearer — the business client is service-role.
    async listPendingInvites(ctx: { accessToken?: string } = {}) {
      const client = clientForToken(ctx.accessToken);
      const { data, error } = await client.rpc("list_pending_invites_for_me");
      if (error) throw new ApiError(400, "validation_failed", error.message ?? "list_pending_invites_for_me failed");
      return {
        items: (data ?? []).map((row) => ({
          inviteId: requiredString(row.invite_id, "auth.listPendingInvites", "invite_id"),
          teamId: requiredString(row.team_id, "auth.listPendingInvites", "team_id"),
          teamName: row.team_name ?? null,
          teamRole: row.team_role ?? null,
          displayName: row.display_name ?? null,
          invitedByDisplayName: row.invited_by_display_name ?? null,
          inviteEmail: row.invite_email ?? null,
          invitePhone: row.invite_phone ?? null,
          expiresAt: row.expires_at ?? null,
          matchedVia: row.matched_via ?? null,
        })),
      };
    },

    async acceptPendingInvite(inviteId, ctx: { accessToken?: string } = {}) {
      const client = clientForToken(ctx.accessToken);
      const { data, error } = await client.rpc("accept_pending_invite", { p_invite_id: inviteId });
      if (error) throw mapPendingInviteError(error, "accept_pending_invite failed");
      const row = requiredRow(data, "auth.acceptPendingInvite");
      const result = {
        actorId: requiredString(row.actor_id, "auth.acceptPendingInvite", "actor_id"),
        teamId: requiredString(row.team_id, "auth.acceptPendingInvite", "team_id"),
        actorType: requiredString(row.actor_type, "auth.acceptPendingInvite", "actor_type"),
        displayName: requiredString(row.display_name, "auth.acceptPendingInvite", "display_name"),
        refreshToken: row.refresh_token ?? null,
      };
      if (result.actorType === "member" && ctx.accessToken) {
        const { data: userData } = await client.auth.getUser();
        const userId = userData?.user?.id;
        if (userId) {
          await assignSystemOrgRole(client, {
            teamId: result.teamId,
            userId,
            code: "member",
          });
        }
      }
      return result;
    },

    async declinePendingInvite(inviteId, ctx: { accessToken?: string } = {}) {
      const client = clientForToken(ctx.accessToken);
      const { error } = await client.rpc("decline_pending_invite", { p_invite_id: inviteId });
      if (error) throw mapPendingInviteError(error, "decline_pending_invite failed");
    },

    // Switch the caller's active team (and org), minting a fresh server session.
    // `switch_active_team` is a SECURITY DEFINER function in the `amux` schema;
    // like `claim_team_invite` above it resolves via a plain `.rpc(...)` since
    // clientForToken's default schema is `amux`. The caller bearer is
    // forwarded so `auth.uid()` resolves to the switching user (member check +
    // org swap). 42501 (non-member / unauthenticated) maps to 403.
    async switchActiveTeam(teamId, ctx: { accessToken?: string } = {}) {
      const client = clientForToken(ctx.accessToken);
      const { data, error } = await client.rpc("switch_active_team", { p_team_id: teamId });
      if (error) {
        const code = error?.code || "";
        if (code === "42501") {
          throw new ApiError(403, "forbidden", error.message ?? "not a member of this team");
        }
        throw new ApiError(400, "validation_failed", error.message ?? "switch failed");
      }
      const row = requiredRow(data, "teams.switchActiveTeam");
      return {
        actorId: row.actor_id ?? null,
        teamId: requiredString(row.team_id, "teams.switchActiveTeam", "team_id"),
        refreshToken: requiredString(row.refresh_token, "teams.switchActiveTeam", "refresh_token"),
      };
    },

    async refreshAccessToken({ refreshToken }) {
      const url = `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: publishableKey,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new ApiError(401, "missing_auth", `Token refresh failed: ${text}`);
      }

      const body = await res.json();
      return {
        accessToken: requiredString(body.access_token, "auth.refreshAccessToken", "access_token"),
        refreshToken: requiredString(body.refresh_token, "auth.refreshAccessToken", "refresh_token"),
        expiresAt: requiredInteger(body.expires_at, "auth.refreshAccessToken", "expires_at"),
      };
    },

    async signInAnonymous() {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/signup",
        body: { data: {} },
        operation: "auth.signInAnonymous",
      });
    },

    // ── Phone login (partner-aligned, see phone-auth.ts) ──────────────────────
    async phoneSendCode({ phone, captchaVerify }) {
      return phoneRepo().sendCode({ phone, captchaVerify });
    },
    async phoneLogin({ phone, code, userId }) {
      return phoneRepo().login({ phone, code, userId });
    },

    async signInOtp({ email, phone, options }) {
      // GoTrue /otp accepts either `email` or `phone` (E.164). For phone the
      // `channel` option ("sms" | "whatsapp") selects delivery; default sms.
      const body: Record<string, any> = {};
      if (typeof email === "string" && email.length > 0) body.email = email;
      if (typeof phone === "string" && phone.length > 0) {
        body.phone = phone;
        if (!options || typeof options !== "object" || !("channel" in options)) {
          body.channel = "sms";
        }
      }
      if (options && typeof options === "object") {
        Object.assign(body, options);
      }
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/otp",
        body,
        operation: "auth.signInOtp",
      });
    },

    async verifyOtp({ email, phone, token, type = "email" }) {
      // For phone OTP, GoTrue expects { phone, token, type: "sms" }.
      const body: Record<string, any> = { token, type };
      if (typeof email === "string" && email.length > 0) body.email = email;
      if (typeof phone === "string" && phone.length > 0) body.phone = phone;
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/verify",
        body,
        operation: "auth.verifyOtp",
      });
    },

    async signOut({ accessToken }) {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/logout",
        bearerToken: accessToken,
        body: null,
        operation: "auth.signOut",
      });
    },

    async updateUser({ accessToken, body }) {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "PUT",
        path: "/auth/v1/user",
        bearerToken: accessToken,
        body: body ?? {},
        operation: "auth.updateUser",
      });
    },

    // Sign in (or sign up) with an OIDC ID token from a native provider.
    // GoTrue's `grant_type=id_token` endpoint verifies the token signature
    // against the provider, then mints / returns a Supabase session.
    async signInWithIdToken({ provider, idToken, nonce, accessToken }) {
      const body: any = { provider, id_token: idToken };
      if (nonce) body.nonce = nonce;
      // When a bearer is forwarded, GoTrue links the OIDC identity to the
      // existing (e.g. anonymous) user instead of minting a new one — this
      // backs the anonymous → Apple upgrade flow.
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/token?grant_type=id_token",
        bearerToken: accessToken,
        body,
        operation: "auth.signInWithIdToken",
      });
    },

    async signInWithPassword({ email, password }) {
      return goTrueRequest({
        fetchImpl, supabaseUrl, apiKey: publishableKey,
        method: "POST", path: "/auth/v1/token?grant_type=password",
        body: { email, password }, operation: "auth.signInWithPassword",
      });
    },

    async signUp({ email, password }) {
      return goTrueRequest({
        fetchImpl, supabaseUrl, apiKey: publishableKey,
        method: "POST", path: "/auth/v1/signup",
        body: { email, password }, operation: "auth.signUp",
      });
    },

    oauthAuthorizeUrl({ provider, redirect, codeChallenge }) {
      // Use the public base — this URL is opened in the user's browser.
      const u = new URL(`${supabasePublicUrl}/auth/v1/authorize`);
      u.searchParams.set("provider", provider);
      u.searchParams.set("redirect_to", redirect);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "s256");
      return u.toString();
    },

    async exchangePkceCode({ code, codeVerifier }) {
      return goTrueRequest({
        fetchImpl, supabaseUrl, apiKey: publishableKey,
        method: "POST", path: "/auth/v1/token?grant_type=pkce",
        body: { auth_code: code, code_verifier: codeVerifier },
        operation: "auth.exchangePkceCode",
      });
    },
  };
}

async function goTrueRequest({
  fetchImpl,
  supabaseUrl,
  apiKey,
  method,
  path,
  body,
  bearerToken = undefined,
  operation,
}: any) {
  const headers: any = {
    "Content-Type": "application/json",
    apikey: apiKey,
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const init: any = { method, headers };
  if (body !== undefined && body !== null) {
    init.body = JSON.stringify(body);
  } else if (method !== "GET" && method !== "HEAD") {
    init.body = "{}";
  }
  const res = await fetchImpl(`${supabaseUrl}${path}`, init);

  // Logout returns 204 No Content on success.
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!res.ok) {
    const message = parsed?.msg || parsed?.message || parsed?.error_description || parsed?.error || text || `GoTrue ${path} failed`;
    const code = res.status === 401 ? "missing_auth" : res.status === 422 ? "validation_failed" : "upstream_unavailable";
    throw new ApiError(res.status, code, `${operation}: ${message}`, { details: parsed });
  }

  return parsed ?? {};
}
