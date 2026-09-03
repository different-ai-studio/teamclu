/**
 * Knowledge path ACL — Cloud API client module.
 *
 * Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * These endpoints are owner/admin only and manage the RULES. Enforcement happens
 * server-side on `/sync/*`; nothing here affects what a client can reach.
 *
 * A member without access never learns a restricted directory exists — it is
 * absent from their sync, not shown locked — so this module is only ever used
 * from the admin surface.
 */

import type { CloudApiClient } from '@/lib/backend/cloud-api/http';

export interface KnowledgeAclRule {
  id: string;
  /** Always `knowledge/…/`, with a trailing slash. */
  pathPrefix: string;
  /** Actors granted access. Members in practice — agents inherit their device owner. */
  actorIds: string[];
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Present on the create response. */
  affectedFiles?: number;
  affectedMembers?: number;
}

/** What restricting a prefix would take away. Shown before the admin confirms. */
export interface KnowledgeAclImpact {
  pathPrefix: string;
  affectedFiles: number;
  affectedMembers: number;
}

interface KnowledgeAclWrite {
  pathPrefix: string;
  actorIds?: string[];
  /**
   * Required when the prefix already holds files — acknowledges that those files
   * are removed from every unlisted member's device on their next sync.
   * Without it the server answers 409 rather than guessing.
   */
  confirmRevokeExisting?: boolean;
}

export interface KnowledgeAclBackend {
  listKnowledgeAcl(teamId: string): Promise<KnowledgeAclRule[]>;
  /** Dry run — writes nothing. Feeds the confirmation screen. */
  previewKnowledgeAcl(
    teamId: string,
    input: { pathPrefix: string; actorIds?: string[] },
  ): Promise<KnowledgeAclImpact>;
  createKnowledgeAcl(teamId: string, input: KnowledgeAclWrite): Promise<KnowledgeAclRule>;
  updateKnowledgeAcl(
    teamId: string,
    aclId: string,
    patch: { addActorIds?: string[]; removeActorIds?: string[] },
  ): Promise<KnowledgeAclRule>;
  /** Reopens the prefix to the whole team. */
  deleteKnowledgeAcl(teamId: string, aclId: string): Promise<void>;
}

export function createKnowledgeAclModule(client: CloudApiClient): KnowledgeAclBackend {
  const basePath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/knowledge-acl`;
  const rulePath = (teamId: string, aclId: string) =>
    `${basePath(teamId)}/${encodeURIComponent(aclId)}`;

  return {
    async listKnowledgeAcl(teamId) {
      const out = await client.get<{ items: KnowledgeAclRule[] }>(basePath(teamId));
      return out.items ?? [];
    },

    async previewKnowledgeAcl(teamId, input) {
      return client.post<KnowledgeAclImpact>(`${basePath(teamId)}/preview`, input);
    },

    async createKnowledgeAcl(teamId, input) {
      return client.post<KnowledgeAclRule>(basePath(teamId), input);
    },

    async updateKnowledgeAcl(teamId, aclId, patch) {
      return client.patch<KnowledgeAclRule>(rulePath(teamId, aclId), patch);
    },

    async deleteKnowledgeAcl(teamId, aclId) {
      await client.delete<void>(rulePath(teamId, aclId));
    },
  };
}
