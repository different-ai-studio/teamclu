import type { CloudApiClient } from "./http";

/**
 * Team env secrets client.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * Every value crossing this boundary is already ciphertext. Encryption and
 * decryption happen in Rust (`teamclu_runtime_env::team_crypto`) because that
 * is where the team key lives; this module only moves opaque envelopes.
 *
 * Consequently there is no `description`/`category` here even though the UI
 * shows both — that metadata is encrypted alongside the value, so it arrives
 * only after the Rust side decrypts.
 */

interface TeamEnvEnvelope {
  v: number;
  /** Base64 12-byte nonce. */
  nonce: string;
  /** Base64 ciphertext including the GCM tag. */
  ciphertext: string;
}

export interface TeamEnvSecret {
  keyId: string;
  envelope: TeamEnvEnvelope;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TeamEnvSecretsBackend {
  listTeamEnvSecrets(teamId: string): Promise<TeamEnvSecret[]>;
  /** Upsert. `createdBy` is never reassigned — it is the delete gate. */
  putTeamEnvSecret(
    teamId: string,
    keyId: string,
    envelope: TeamEnvEnvelope,
  ): Promise<TeamEnvSecret>;
  deleteTeamEnvSecret(teamId: string, keyId: string): Promise<void>;
}

export function createTeamEnvSecretsModule(client: CloudApiClient): TeamEnvSecretsBackend {
  const basePath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/env-secrets`;
  const keyPath = (teamId: string, keyId: string) =>
    `${basePath(teamId)}/${encodeURIComponent(keyId)}`;

  return {
    async listTeamEnvSecrets(teamId) {
      const out = await client.get<{ items: TeamEnvSecret[] }>(basePath(teamId));
      return out.items ?? [];
    },

    async putTeamEnvSecret(teamId, keyId, envelope) {
      return client.put<TeamEnvSecret>(keyPath(teamId, keyId), { envelope });
    },

    async deleteTeamEnvSecret(teamId, keyId) {
      await client.delete<void>(keyPath(teamId, keyId));
    },
  };
}
