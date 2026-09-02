import type { CloudApiClient } from "./http";

/**
 * Team MCP catalog client.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * Note what is missing compared to the skills client: there is no `actorId`
 * anywhere. Installing a team MCP server means running its `command` on your own
 * machine, so it is self-only by construction — there is no call here that can
 * act on another actor's install set, deliberately.
 */

type TeamMcpTransport = "local" | "remote";

export interface TeamMcpServer {
  id: string;
  teamId: string;
  name: string;
  transport: TeamMcpTransport;
  command: string | null;
  args: string[] | null;
  url: string | null;
  headers: Record<string, string> | null;
  env: Record<string, string> | null;
  description: string | null;
  /** Whether the *calling* actor has installed it. */
  installed: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TeamMcpServerWrite {
  name?: string;
  transport?: TeamMcpTransport;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  headers?: Record<string, string> | null;
  env?: Record<string, string> | null;
  description?: string | null;
}

interface TeamMcpInstall {
  id: string;
  teamId: string;
  actorId: string;
  serverId: string;
  name: string;
  installedAt: string | null;
  updatedAt: string | null;
}

/**
 * Key names whose value the server will reject unless it is a `${KEY}`
 * placeholder. Mirrors `SECRET_KEY_RE` in
 * `services/fc/src/lib/pg-repo/team-mcp.ts`.
 *
 * Duplicated here so the UI can say "that looks like a secret" while the user is
 * still typing, rather than surfacing a 422 after they hit save. The server
 * remains the authority — this copy is a courtesy, not a gate.
 */
const MCP_SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** `${FOO}` or `$FOO`, the forms the daemon resolves from team env at runtime. */
const MCP_PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the offending key names, or an empty array when the map is fine.
 * Callers use this to mark fields inline before submitting.
 */
export function findLiteralSecretKeys(map: Record<string, string> | null | undefined): string[] {
  if (!map) return [];
  return Object.entries(map)
    .filter(([k, v]) => MCP_SECRET_KEY_RE.test(k) && !MCP_PLACEHOLDER_RE.test((v ?? "").trim()))
    .map(([k]) => k);
}

export interface TeamMcpBackend {
  /** Full catalog; every row carries the caller's own `installed` flag. */
  listTeamMcpServers(teamId: string): Promise<TeamMcpServer[]>;
  createTeamMcpServer(teamId: string, input: TeamMcpServerWrite): Promise<TeamMcpServer>;
  updateTeamMcpServer(
    teamId: string,
    name: string,
    patch: TeamMcpServerWrite,
  ): Promise<TeamMcpServer>;
  deleteTeamMcpServer(teamId: string, name: string): Promise<void>;
  /** Install for yourself. There is no "install for someone else". */
  installTeamMcpServer(teamId: string, name: string): Promise<TeamMcpInstall>;
  uninstallTeamMcpServer(teamId: string, name: string): Promise<void>;
}

export function createTeamMcpModule(client: CloudApiClient): TeamMcpBackend {
  const basePath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/mcp-servers`;
  const serverPath = (teamId: string, name: string) =>
    `${basePath(teamId)}/${encodeURIComponent(name)}`;

  return {
    async listTeamMcpServers(teamId) {
      const out = await client.get<{ items: TeamMcpServer[] }>(basePath(teamId));
      return out.items ?? [];
    },

    async createTeamMcpServer(teamId, input) {
      return client.post<TeamMcpServer>(basePath(teamId), input);
    },

    async updateTeamMcpServer(teamId, name, patch) {
      return client.patch<TeamMcpServer>(serverPath(teamId, name), patch);
    },

    async deleteTeamMcpServer(teamId, name) {
      await client.delete<void>(serverPath(teamId, name));
    },

    async installTeamMcpServer(teamId, name) {
      // No body: passing an actorId is a 400 server-side, and there is nothing
      // else to say.
      return client.put<TeamMcpInstall>(`${serverPath(teamId, name)}/install`, {});
    },

    async uninstallTeamMcpServer(teamId, name) {
      await client.delete<void>(`${serverPath(teamId, name)}/install`);
    },
  };
}
