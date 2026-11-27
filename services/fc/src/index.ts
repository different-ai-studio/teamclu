import {
  createSupabaseAuthRepository,
  createSupabaseBusinessRepository,
  publishableKeyFromEnv,
} from "./lib/supabase-repo.js";
import { fanoutMessage } from "./lib/push-dispatch.js";
import { ssoServiceFromEnv } from "./lib/sso/from-env.js";
import { pushDeps } from "./lib/admin-handlers.js";
import { ApiError } from "./lib/http-utils.js";
import { assertSupportSessionLive, cachedAgentAccessCheck } from "./lib/platform-operators.js";
import {
  makeAppDataDeps,
  makeAppLogsDeps,
  makeAppStorageDeps,
  makeDeployDeps,
  makeTeardownDeps,
} from "./lib/app-platform/deps.js";
import { forgeFromEnv } from "./lib/forge/index.js";
import { readGotrueOAuthConfig, makeGotrueOAuthClient } from "./lib/provisioning/gotrue-oauth.js";
import { makeVanityLookup } from "./lib/apps-vanity.js";
import { makeSupabaseLoginAppLookup } from "./lib/apps-login-service.js";
import { findTenantIdentity } from "./lib/apps-tenant-identity.js";
import { makeSupabaseTraefikDomainLookup } from "./lib/apps-traefik-provider.js";
import { createServiceRoleClient } from "./lib/supabase.js";
import { appRoleBindings } from "./lib/app-role-bindings.js";
import { findAppOrgRoleIdentities } from "./lib/apps-org-role-identity.js";

// ---------------------------------------------------------------------------
// Environment (used only for /v1 business API). Read lazily inside the deps
// closures so importing this module never requires env at load time.
// ---------------------------------------------------------------------------
const SUPABASE_URL_FN = () =>
  process.env.FC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL || "";
// Public, browser-reachable GoTrue base used for OAuth `authorize` redirects.
// SUPABASE_URL is typically an internal/VPC address the browser can't reach.
const SUPABASE_PUBLIC_URL_FN = () =>
  process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || "";
const SUPABASE_PUBLISHABLE_KEY = () => publishableKeyFromEnv(process.env);

// Who hosts apps' code: the forge integration over this deployment's Gitea.
// With any of GITEA_URL / GITEA_TOKEN / GITEA_OWNER empty, createApp surfaces
// a 503 that names the missing variable rather than half-provisioning a row.
function makeForgeDeps() {
  return { forge: forgeFromEnv() };
}

function makeGotrueOAuthDeps() {
  const resolved = readGotrueOAuthConfig();
  if (resolved.error) return { gotrueUnavailableReason: resolved.error };
  return { gotrue: makeGotrueOAuthClient(resolved.config) };
}

export { makeForgeDeps };

/**
 * Vanity-host lookup, wired for whichever backend this deployment runs.
 *
 * Exported for the container entry (server.ts), the only `createApp()` call.
 */
export function vanityLookup() {
  return makeVanityLookup({ getServiceRoleClient: createServiceRoleClient });
}

/** uuid columns: a non-uuid `.eq()` is a query ERROR, not an empty result. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * App lookup for the central login service, wired the same way and for the same
 * reason as {@link vanityLookup}: the login hostname is unauthenticated by
 * nature — there is no bearer token to scope RLS with — so it reads the
 * control-plane database with the service role, like the vanity, cron and push
 * paths do.
 *
 * The uuid guard is not defensive coding. `apps.id` is a uuid column and the id
 * here comes straight off a query string, so a malformed one makes PostgREST
 * fail the whole query rather than return no rows — the login page would answer
 * 500 instead of "no such app". Same shape of trap as the `id like '…%'` filter
 * that `apps-vanity.ts` documents.
 */
export function loginAppLookup() {
  return makeSupabaseLoginAppLookup(createServiceRoleClient);
}

/**
 * The visitor's identity in an app's org, for the login service (email /
 * password / OAuth sign-ins and the SSO shortcut). Service role: the login
 * service holds no Supabase JWT for the visitor.
 */
export function tenantIdentityLookup() {
  return (visitor: { sub: string; email: string }, orgId: string) =>
    findTenantIdentity(createServiceRoleClient(), visitor, orgId);
}

/**
 * Verified custom domains for Traefik's HTTP provider. Service role for the
 * same tokenless reason as {@link vanityLookup}: Traefik is the caller.
 */
export function traefikCustomDomainsLookup() {
  return makeSupabaseTraefikDomainLookup(createServiceRoleClient);
}

/** Resolve the visitor's active role subject in the app's org. */
const ORG_CACHE_TTL_MS = 60_000;
const ORG_CACHE_MAX = 5_000;
const identityCache = new Map<string, { value: string[]; expiresAt: number }>();

export function appOrgRoleIdentitiesLookup() {
  return async (userId: string, orgId: string): Promise<string[]> => {
    if (!UUID_RE.test(userId) || !UUID_RE.test(orgId)) return [];

    const key = `${userId}|${orgId}`;
    const now = Date.now();
    const hit = identityCache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const admin = createServiceRoleClient();
    const value = await findAppOrgRoleIdentities(admin, userId, orgId);
    if (identityCache.size >= ORG_CACHE_MAX) {
      for (const [k, v] of identityCache) if (v.expiresAt <= now) identityCache.delete(k);
      if (identityCache.size >= ORG_CACHE_MAX) identityCache.clear();
    }
    identityCache.set(key, { value, expiresAt: now + ORG_CACHE_TTL_MS });
    return value;
  };
}

/**
 * Active role codes for this account's role-bearing identities — gateway role admit + legacy
 * `audience: org` (any `roles_users` row).
 *
 * Each id is a `public.users.id` with an active role binding in this org,
 * not necessarily a user row whose default org_id is this org. None is
 * inferred from the auth uid without verifying the binding's org_id.
 *
 * Service-role for the same tokenless reason as {@link appOrgRoleIdentitiesLookup}:
 * the request carries an app-session cookie, not a Supabase JWT.
 */
const ROLE_CACHE_TTL_MS = 60_000;
const ROLE_CACHE_MAX = 5_000;
const visitorRoleCache = new Map<string, { value: string[]; expiresAt: number }>();

export function visitorRolesLookup() {
  return async (identityIds: string[], orgId: string): Promise<string[]> => {
    if (!orgId || identityIds.length === 0 || identityIds.some((id) => !UUID_RE.test(id))) return [];

    const key = `${identityIds.join(",")}|${orgId}`;
    const now = Date.now();
    const hit = visitorRoleCache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const admin = createServiceRoleClient();
    const bindings = await appRoleBindings(admin, orgId, identityIds);

    const roleIds = [...new Set((bindings ?? []).map((b: any) => b.role_id).filter(Boolean))];
    let codes: string[] = [];
    if (roleIds.length > 0) {
      const { data: roles, error: rolesErr } = await admin
        .schema("public")
        .from("roles")
        .select("id, code, status")
        .in("id", roleIds)
        .eq("status", "active");
      if (rolesErr) throw new Error(`visitor role codes lookup failed: ${rolesErr.message}`);
      codes = (roles ?? [])
        .map((r: any) => r.code)
        .filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
    }

    if (visitorRoleCache.size >= ROLE_CACHE_MAX) {
      for (const [k, v] of visitorRoleCache) if (v.expiresAt <= now) visitorRoleCache.delete(k);
      if (visitorRoleCache.size >= ROLE_CACHE_MAX) visitorRoleCache.clear();
    }
    visitorRoleCache.set(key, { value: codes, expiresAt: now + ROLE_CACHE_TTL_MS });
    return codes;
  };
}

// ---------------------------------------------------------------------------
// Repository factories. Built lazily per request so importing this module
// needs no environment.
// ---------------------------------------------------------------------------

export function makeAuthRepoFactory() {
  return () =>
    createSupabaseAuthRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      supabasePublicUrl: SUPABASE_PUBLIC_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
      // Phone login (partner-aligned). Enabled only when all four are set.
      // PHONE_EMAIL_DOMAIN is part of the account identity — it must match the
      // partner SaaS sharing this GoTrue (see supabase-repo/phone-auth.ts).
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
      defaultOrgId: process.env.DEFAULT_ORG_ID || undefined,
      phoneEmailDomain: process.env.PHONE_EMAIL_DOMAIN || undefined,
      phoneAuthEncryptionKey: process.env.PHONE_AUTH_ENCRYPTION_KEY || undefined,
      smsDebugMode: process.env.SMS_DEBUG_MODE === "1" || process.env.SMS_DEBUG_MODE === "true",
      // Whose SMS account sends verification codes. Falls back to DEFAULT_ORG_ID,
      // which is being retired (docs/plans/2026-10-08-staff-only-identity-model.md).
      smsConfigOrgId: process.env.SMS_CONFIG_ORG_ID || undefined,
      syncTeamToGitea: makeTeamForgeSync(),
      ssoService: () =>
        ssoServiceFromEnv({
          env: process.env,
          supabaseUrl: SUPABASE_URL_FN(),
          publishableKey: SUPABASE_PUBLISHABLE_KEY(),
        }),
    });
}

/** Team re-sync for the auth repository's join paths; a no-op unless GITEA_ACCOUNT_AUTH=on. */
function makeTeamForgeSync() {
  const forge = forgeFromEnv()({
    serviceRoleClient: async () => {
      const { createServiceRoleClient } = await import("./lib/supabase.js");
      return createServiceRoleClient();
    },
  });
  return (teamId: string) => forge.teamAccessChanged(teamId);
}

/**
 * Whether a support session's grant is still live, asked with service_role
 * (support_session_info is not callable by clients). No service-role key means
 * no support session could have been opened here: answer "not live".
 */
async function supportGrantIsLive(userId: string, sessionId: string): Promise<boolean> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const base = SUPABASE_URL_FN();
  if (!serviceKey || !base) return false;
  const res = await fetch(`${base.replace(/\/+$/, "")}/rest/v1/rpc/support_session_info`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      "Content-Profile": "amux",
    },
    body: JSON.stringify({ p_user_id: userId, p_session_id: sessionId }),
  });
  if (!res.ok) throw new Error(`support_session_info ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Whether an agent account may act (amux.support_agent_access_live): false only
 * for a bot set up in a support session whose grant has ended. No service-role
 * key means no support session could have been opened here: answer "live".
 */
async function supportAgentAccessIsLive(userId: string): Promise<boolean> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const base = SUPABASE_URL_FN();
  if (!serviceKey || !base) return true;
  const res = await fetch(`${base.replace(/\/+$/, "")}/rest/v1/rpc/support_agent_access_live`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      "Content-Profile": "amux",
    },
    body: JSON.stringify({ p_user_id: userId }),
  });
  // Older database without the function: nothing is a support agent yet.
  if (res.status === 404) return true;
  if (!res.ok) throw new Error(`support_agent_access_live ${res.status}`);
  return (await res.json()) !== false;
}

const supportAgentAccessCheck = cachedAgentAccessCheck(supportAgentAccessIsLive);

export function makeBusinessRepoFactory() {
  return async ({ accessToken }: { accessToken: string }) => {
    // A support account whose grant ended, or a bot set up under such a grant,
    // is refused here, before any route runs — see assertSupportSessionLive.
    await assertSupportSessionLive(accessToken, supportGrantIsLive, supportAgentAccessCheck);
    return createSupabaseBusinessRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      supabasePublicUrl: SUPABASE_PUBLIC_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
      accessToken,
      fanoutMessage: async (record) => { await fanoutMessage(record, pushDeps()); },
      publishSessionParticipantInbox: async (topic: string, body: string) => {
        const mqtt = pushDeps().mqtt;
        if (!mqtt) return;
        await mqtt.publish(topic, body);
      },
      ...makeDeployDeps(),
      ...makeTeardownDeps(),
      ...makeAppDataDeps(),
      ...makeAppStorageDeps(),
      ...makeAppLogsDeps(),
      ...makeForgeDeps(),
      ...makeGotrueOAuthDeps(),
    });
  };
}

/** System/admin repository — no user JWT (marketplace admin shared-secret routes). */
export function makeSystemRepoFactory() {
  return () => {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!serviceKey) {
      throw new ApiError(
        503,
        "unavailable",
        "SUPABASE_SERVICE_ROLE_KEY is required for marketplace admin",
      );
    }
    return createSupabaseBusinessRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      supabasePublicUrl: SUPABASE_PUBLIC_URL_FN(),
      // Service-role key as both the client key and bearer — bypasses RLS for
      // catalog writes. Admin endpoints never call getUser().
      publishableKey: serviceKey,
      accessToken: serviceKey,
      ...makeDeployDeps(),
      ...makeAppStorageDeps(),
      ...makeForgeDeps(),
      ...makeGotrueOAuthDeps(),
    });
  };
}
