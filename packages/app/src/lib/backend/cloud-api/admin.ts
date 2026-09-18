/**
 * Platform operator surface — Cloud API client.
 *
 * A platform operator runs the deployment this client is pointed at. It is not
 * a team or org role, and nothing in a team makes someone one: the deployment
 * lists them in `PLATFORM_OPERATOR_USER_IDS`
 * (services/fc/src/lib/platform-operators.ts).
 *
 * OpenAPI: getAdminWhoami / getProviderPools / resetProviderPool
 */

import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export interface PlatformWhoami {
  /** The caller's own user id — what goes into PLATFORM_OPERATOR_USER_IDS. */
  userId: string;
  operator: boolean;
}

/**
 * Why a provider key is sitting out.
 *
 * `model: null` is the whole key (a 402 balance, a rejected key); a model id
 * benches that model on that key only, because subscription quotas and rate
 * limits are metered per model. `active: false` has expired — the key is back
 * in rotation, and the record stays until it serves so repeated failures keep
 * backing off.
 */
export interface ProviderPoolCooldown {
  model: string | null;
  class: "exhausted" | "rate_limited" | "invalid";
  active: boolean;
  until: string;
  strikes: number;
  status: number;
  error: string;
  at: string;
}

export interface ProviderPoolKey {
  /** sha256 prefix. The key itself never leaves the gateway. */
  id: string;
  /** The key's last four characters, after an ellipsis. */
  hint: string;
  /** Priority: the gateway tries a lower position first. */
  position: number;
  ok: number;
  failed: number;
  lastUsedAt: string | null;
  cooldowns: ProviderPoolCooldown[];
}

export interface ProviderPool {
  providerId: string;
  keys: ProviderPoolKey[];
}

export interface AdminOrg {
  id: string;
  name: string;
  code: string | null;
  status: string | null;
  createdAt: string;
  teamCount: number;
  /** Distinct people across the org's teams — somebody in two counts once. */
  memberCount: number;
}

export interface AdminTeamRow {
  id: string;
  slug: string;
  name: string | null;
  orgId: string | null;
  orgName: string | null;
  createdAt: string;
  memberCount: number;
  balanceCredits: number;
  /** Credits spent this calendar month, Asia/Shanghai. */
  periodCredits: number;
}

export interface AdminMemberQuota {
  actorId: string;
  displayName: string | null;
  actorType: string | null;
  /** null means no limit. */
  limitCredits: number | null;
}

export interface AdminTeamCredits {
  team: {
    id: string;
    slug: string;
    name: string | null;
    orgId: string | null;
    orgName: string | null;
    createdAt: string;
  };
  balanceCredits: number;
  usage: {
    range: string;
    startUtc: string;
    endUtc: string;
    summary: { credits: number; inputTokens?: number; outputTokens?: number; requests?: number };
    byActor?: Array<{ actorId: string | null; displayName: string | null; credits: number }>;
    byModel?: Array<{ publicModelId: string; credits: number }>;
  };
  ledger: Array<{ id: string; kind: string; amountCredits: number; note: string | null; createdAt: string }>;
  quotas: {
    period: "week" | "month";
    defaultLimitCredits: number | null;
    lowBalanceCredits: number | null;
    members: AdminMemberQuota[];
  };
  /** Everyone in the team, so a limit can be added for someone who has none. */
  actors: Array<{ id: string; displayName: string | null; actorType: string | null }>;
}

export interface AdminQuotaInput {
  period?: "week" | "month";
  defaultLimitCredits?: number | null;
  lowBalanceCredits?: number | null;
  members?: Array<{ actorId: string; limitCredits: number | null }>;
}

export interface AdminBackend {
  /** Answers any signed-in caller, operator or not. */
  whoami(): Promise<PlatformWhoami>;
  /** Operator-only. Counters and cooldowns reset when the gateway restarts. */
  getProviderPools(): Promise<ProviderPool[]>;
  /** Operator-only. Omit `keyId` to clear every key of the provider. */
  resetProviderPool(providerId: string, keyId?: string): Promise<{ cleared: number }>;
  listOrgs(opts?: { query?: string; limit?: number; offset?: number }): Promise<{ items: AdminOrg[]; total: number }>;
  updateOrg(orgId: string, patch: { name?: string; status?: "active" | "inactive" }): Promise<AdminOrg>;
  listTeams(opts?: {
    query?: string;
    orgId?: string;
    sort?: "balance" | "usage";
    limit?: number;
    offset?: number;
  }): Promise<{ items: AdminTeamRow[]; total: number; truncated: boolean }>;
  getTeamCredits(teamId: string): Promise<AdminTeamCredits>;
  setTeamQuotas(teamId: string, input: AdminQuotaInput): Promise<{ ok?: boolean }>;
}

/** Drops empty values so `?query=` never reaches the server as a blank filter. */
function queryString(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function createAdminModule(client: CloudApiClient): AdminBackend {
  return {
    async whoami() {
      return client.get<PlatformWhoami>("/v1/admin/whoami");
    },

    async getProviderPools() {
      const out = await client.get<{ providers: ProviderPool[] }>("/v1/admin/ai/provider-pools");
      return out.providers ?? [];
    },

    async resetProviderPool(providerId, keyId) {
      return client.post<{ cleared: number }>(
        `/v1/admin/ai/provider-pools/${encodeURIComponent(providerId)}/reset`,
        keyId ? { keyId } : {},
      );
    },

    async listOrgs(opts = {}) {
      return client.get<{ items: AdminOrg[]; total: number }>(`/v1/admin/orgs${queryString(opts)}`);
    },

    async updateOrg(orgId, patch) {
      return client.patch<AdminOrg>(`/v1/admin/orgs/${encodeURIComponent(orgId)}`, patch);
    },

    async listTeams(opts = {}) {
      return client.get<{ items: AdminTeamRow[]; total: number; truncated: boolean }>(
        `/v1/admin/teams${queryString(opts)}`,
      );
    },

    async getTeamCredits(teamId) {
      return client.get<AdminTeamCredits>(`/v1/admin/teams/${encodeURIComponent(teamId)}/credits`);
    },

    async setTeamQuotas(teamId, input) {
      return client.put<{ ok?: boolean }>(`/v1/admin/teams/${encodeURIComponent(teamId)}/quotas`, input);
    },
  };
}
