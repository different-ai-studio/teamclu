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

export interface AdminBackend {
  /** Answers any signed-in caller, operator or not. */
  whoami(): Promise<PlatformWhoami>;
  /** Operator-only. Counters and cooldowns reset when the gateway restarts. */
  getProviderPools(): Promise<ProviderPool[]>;
  /** Operator-only. Omit `keyId` to clear every key of the provider. */
  resetProviderPool(providerId: string, keyId?: string): Promise<{ cleared: number }>;
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
  };
}
