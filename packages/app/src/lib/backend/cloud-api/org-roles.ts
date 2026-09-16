/**
 * Org-scoped role catalog + member role assignment — Cloud API client.
 *
 * Design: docs/specs/2026-09-15-org-roles-permissions-design.md §2.1–2.2
 * OpenAPI: listOrgRoles / createOrgRole / patchOrgRole / deleteOrgRole /
 *          getMemberOrgRoles / putMemberOrgRoles
 */

import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export interface OrgRole {
  id: string;
  orgId: string;
  name: string;
  code: string;
  description: string | null;
  isSystem: boolean;
  status: "active" | "inactive" | string;
  sort: number;
  parentRoleId: string | null;
}

export interface OrgRoleCreate {
  name: string;
  code: string;
  description?: string;
  sort?: number;
}

export interface OrgRolePatch {
  name?: string;
  description?: string | null;
  status?: "active" | "inactive";
  sort?: number;
}

export interface MemberRoleRef {
  id: string;
  code: string;
  name: string;
}

/** Privilege order for transitional `teamRole` / `role` derivation. */
const TEAM_ROLE_RANK: Record<string, number> = {
  owner: 1,
  admin: 2,
  finance: 3,
  member: 4,
};

/** Highest privilege among active role codes (`owner > admin > finance > member`). */
export function deriveHighestTeamRole(roles: MemberRoleRef[] | null | undefined): string | null {
  if (!roles?.length) return null;
  let best: MemberRoleRef | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const role of roles) {
    const rank = TEAM_ROLE_RANK[role.code] ?? 99;
    if (rank < bestRank) {
      bestRank = rank;
      best = role;
    }
  }
  return best?.code ?? null;
}

export interface OrgRolesBackend {
  list(teamId: string): Promise<OrgRole[]>;
  create(teamId: string, input: OrgRoleCreate): Promise<OrgRole>;
  patch(teamId: string, roleId: string, patch: OrgRolePatch): Promise<OrgRole>;
  remove(teamId: string, roleId: string): Promise<void>;
  listMemberRoles(teamId: string, actorId: string): Promise<MemberRoleRef[]>;
  putMemberRoles(teamId: string, actorId: string, roleIds: string[]): Promise<MemberRoleRef[]>;
}

export function createOrgRolesModule(client: CloudApiClient): OrgRolesBackend {
  const rolesPath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/roles`;
  const rolePath = (teamId: string, roleId: string) =>
    `${rolesPath(teamId)}/${encodeURIComponent(roleId)}`;
  const memberRolesPath = (teamId: string, actorId: string) =>
    `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(actorId)}/roles`;

  return {
    async list(teamId) {
      const out = await client.get<{ items: OrgRole[] }>(rolesPath(teamId));
      return out.items ?? [];
    },

    async create(teamId, input) {
      return client.post<OrgRole>(rolesPath(teamId), input);
    },

    async patch(teamId, roleId, patch) {
      return client.patch<OrgRole>(rolePath(teamId, roleId), patch);
    },

    async remove(teamId, roleId) {
      await client.delete<void>(rolePath(teamId, roleId));
    },

    async listMemberRoles(teamId, actorId) {
      const out = await client.get<{ items: MemberRoleRef[] }>(memberRolesPath(teamId, actorId));
      return out.items ?? [];
    },

    async putMemberRoles(teamId, actorId, roleIds) {
      const out = await client.put<{ items: MemberRoleRef[] }>(memberRolesPath(teamId, actorId), {
        roleIds,
      });
      return out.items ?? [];
    },
  };
}
