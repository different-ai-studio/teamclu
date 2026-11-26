// SsoStore over Supabase. Everything but resolveOrgManager runs as
// service_role: the sso_* tables and RPCs grant nothing to clients
// (20261126120000_enterprise_sso.sql). resolveOrgManager runs as the caller so
// RLS decides whether they can see the team at all.
import { ApiError } from "../http-utils.js";
import { REALTIME_TRANSPORT_OPTS } from "../supabase-repo/shared.js";
import { SsoTenantNotBoundError, type SsoBinding, type SsoFlow, type SsoStore } from "./sso-service.js";

export interface SupabaseSsoStoreOptions {
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  createClient: (url: string, key: string, opts?: any) => any;
  nowMs?: () => number;
}

function flowFromRow(r: any): SsoFlow {
  return {
    state: r.state,
    provider: r.provider,
    kind: r.kind,
    redirect: r.redirect ?? null,
    codeChallenge: r.code_challenge ?? null,
    orgId: r.org_id ?? null,
    requestedBy: r.requested_by ?? null,
    userId: r.user_id ?? null,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at ?? null,
  };
}

function bindingFromRow(r: any): SsoBinding {
  return {
    provider: r.provider,
    tenantId: r.tenant_id,
    orgId: r.org_id,
    tenantName: r.tenant_name ?? null,
    createdAt: r.created_at,
  };
}

function fail(what: string, error: any): never {
  throw new ApiError(500, "internal", `sso ${what} failed: ${error?.message ?? error}`);
}

export function createSupabaseSsoStore(options: SupabaseSsoStoreOptions): SsoStore {
  const { supabaseUrl, publishableKey, serviceRoleKey, createClient } = options;
  const nowIso = () => new Date((options.nowMs ?? Date.now)()).toISOString();
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "amux" },
    realtime: REALTIME_TRANSPORT_OPTS,
  });
  const FLOW_COLS = "state, provider, kind, redirect, code_challenge, org_id, requested_by, user_id, expires_at, consumed_at";
  const BINDING_COLS = "provider, tenant_id, org_id, tenant_name, created_at";

  return {
    async saveSuiteTicket(provider, suiteId, ticket) {
      const { error } = await admin
        .from("sso_suite_tickets")
        .upsert({ provider, suite_id: suiteId, ticket, updated_at: nowIso() }, { onConflict: "provider,suite_id" });
      if (error) fail("save suite ticket", error);
    },

    async loadSuiteTicket(provider, suiteId) {
      const { data, error } = await admin
        .from("sso_suite_tickets")
        .select("ticket")
        .eq("provider", provider)
        .eq("suite_id", suiteId)
        .maybeSingle();
      if (error) fail("load suite ticket", error);
      return data?.ticket ?? null;
    },

    async createFlow(flow) {
      const { error } = await admin.from("sso_flows").insert({
        state: flow.state,
        provider: flow.provider,
        kind: flow.kind,
        redirect: flow.redirect,
        code_challenge: flow.codeChallenge,
        org_id: flow.orgId,
        requested_by: flow.requestedBy,
        expires_at: flow.expiresAt,
      });
      if (error) fail("create flow", error);
    },

    async getFlow(state) {
      const { data, error } = await admin.from("sso_flows").select(FLOW_COLS).eq("state", state).maybeSingle();
      if (error) fail("read flow", error);
      return data ? flowFromRow(data) : null;
    },

    async completeLoginFlow(state, { userId, codeHash, expiresAt }) {
      const { data, error } = await admin
        .from("sso_flows")
        .update({ user_id: userId, exchange_code_hash: codeHash, expires_at: expiresAt })
        .eq("state", state)
        .eq("kind", "login")
        .is("user_id", null)
        .is("consumed_at", null)
        .gt("expires_at", nowIso())
        .select("state");
      if (error) fail("complete login flow", error);
      return (data ?? []).length === 1;
    },

    async consumeLoginCode(codeHash) {
      const { data, error } = await admin
        .from("sso_flows")
        .update({ consumed_at: nowIso() })
        .eq("exchange_code_hash", codeHash)
        .eq("kind", "login")
        .is("consumed_at", null)
        .select(FLOW_COLS);
      if (error) fail("consume login code", error);
      return data?.[0] ? flowFromRow(data[0]) : null;
    },

    async consumeInstallFlow(state) {
      const { data, error } = await admin
        .from("sso_flows")
        .update({ consumed_at: nowIso() })
        .eq("state", state)
        .eq("kind", "install")
        .is("consumed_at", null)
        .select(FLOW_COLS);
      if (error) fail("consume install flow", error);
      return data?.[0] ? flowFromRow(data[0]) : null;
    },

    async sweepExpiredFlows() {
      // An hour of slack keeps a just-expired row readable for a clear error.
      const cutoff = new Date(Date.parse(nowIso()) - 60 * 60 * 1000).toISOString();
      const { error } = await admin.from("sso_flows").delete().lt("expires_at", cutoff);
      if (error) fail("sweep flows", error);
    },

    async ensureIdentity({ provider, tenantId, subject, nickname }) {
      const { data, error } = await admin.rpc("ensure_sso_identity", {
        p_provider: provider,
        p_tenant_id: tenantId,
        p_subject: subject,
        p_nickname: nickname ?? null,
      });
      if (error) {
        if (error.code === "P0002") throw new SsoTenantNotBoundError(error.message);
        fail("ensure identity", error);
      }
      if (typeof data !== "string" || !data) fail("ensure identity", "no user id");
      return data;
    },

    async mintSession(userId) {
      const { data, error } = await admin.rpc("sso_mint_session", { p_user_id: userId });
      if (error) {
        if (error.code === "42501") throw new ApiError(403, "forbidden", error.message);
        fail("mint session", error);
      }
      if (typeof data !== "string" || !data) fail("mint session", "no refresh token");
      return data;
    },

    async bindingForOrg(provider, orgId) {
      const { data, error } = await admin
        .from("sso_org_bindings")
        .select(BINDING_COLS)
        .eq("provider", provider)
        .eq("org_id", orgId)
        .limit(1);
      if (error) fail("read binding", error);
      return data?.[0] ? bindingFromRow(data[0]) : null;
    },

    async bindingForTenant(provider, tenantId) {
      const { data, error } = await admin
        .from("sso_org_bindings")
        .select(BINDING_COLS)
        .eq("provider", provider)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) fail("read binding", error);
      return data ? bindingFromRow(data) : null;
    },

    async saveBinding({ provider, tenantId, orgId, tenantName, permanentCode, boundBy }) {
      const { error } = await admin.from("sso_org_bindings").upsert(
        {
          provider,
          tenant_id: tenantId,
          org_id: orgId,
          tenant_name: tenantName,
          permanent_code: permanentCode,
          bound_by: boundBy,
          updated_at: nowIso(),
        },
        { onConflict: "provider,tenant_id" },
      );
      if (error) fail("save binding", error);
    },

    async deleteBinding(provider, tenantId) {
      const { error } = await admin.from("sso_org_bindings").delete().eq("provider", provider).eq("tenant_id", tenantId);
      if (error) fail("delete binding", error);
    },

    async resolveOrgManager(accessToken, teamId) {
      const caller = createClient(supabaseUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        db: { schema: "amux" },
        realtime: REALTIME_TRANSPORT_OPTS,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const { data: userData, error: userErr } = await caller.auth.getUser(accessToken);
      const userId = userData?.user?.id;
      if (userErr || !userId) throw new ApiError(401, "unauthorized", "invalid access token");
      const { data: team, error: teamErr } = await caller.from("teams").select("oid").eq("id", teamId).maybeSingle();
      if (teamErr) fail("read team", teamErr);
      if (!team?.oid) throw new ApiError(404, "not_found", "team not found");
      const { data: isManager, error: mgrErr } = await caller.rpc("is_org_role_manager", { p_org_id: team.oid });
      if (mgrErr) fail("check org role", mgrErr);
      if (isManager !== true) {
        throw new ApiError(403, "forbidden", "only an organization owner or admin can manage enterprise sign-in");
      }
      return { userId, orgId: team.oid };
    },
  };
}
