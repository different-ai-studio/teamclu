import type { CloudApiClient } from "./http";

/**
 * Team skills registry client.
 *
 * Design: docs/architecture/team-skills-registry.md
 *
 * `actorId` is the load-bearing parameter throughout. Omitted, every call is
 * about the caller. Passed a `visibility=team` agent's actor id, the same calls
 * read and write that agent's install set — which is how an admin manages a
 * shared agent without a separate "assignment" concept existing anywhere.
 */

export type TeamSkillCategory =
  | "general"
  | "coding"
  | "devops"
  | "data"
  | "research"
  | "writing"
  | "communication"
  | "integration";

export const TEAM_SKILL_CATEGORIES: TeamSkillCategory[] = [
  "general",
  "coding",
  "devops",
  "data",
  "research",
  "writing",
  "communication",
  "integration",
];

export type TeamSkillStatus = "draft" | "published" | "deprecated";

export interface TeamSkill {
  id: string;
  teamId: string;
  slug: string;
  ownerActorId: string;
  summary: string;
  category: TeamSkillCategory;
  whenToUse: string;
  /** Required at publish time — the field that lets two similar skills be told apart. */
  whenNotToUse: string;
  requires: string[] | null;
  status: TeamSkillStatus;
  supersededBy: string | null;
  latestVersion: number;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
  origin?: "local" | "marketplace";
  upstreamSlug?: string | null;
  upstreamSubscribed?: boolean;
  upstreamDetachedAt?: string | null;
  installed: boolean;
  installedVersion: number | null;
  installScope: "global" | "workspace" | null;
  hasUpdate: boolean;
}

export interface TeamSkillVersion {
  version: number;
  contentHash: string;
  size: number;
  changelog: string;
  summary: string;
  whenToUse: string;
  whenNotToUse: string;
  requires: string[] | null;
  createdBy: string;
  publishedFromVersion: number | null;
  createdAt: string | null;
}

export interface TeamSkillDetail extends TeamSkill {
  versions: TeamSkillVersion[];
}

export interface TeamSkillInstall {
  id: string;
  teamId: string;
  actorId: string;
  skillId: string;
  installedVersion: number;
  scope: "global" | "workspace";
  workspaceId: string | null;
  slug?: string;
  latestVersion?: number;
  status?: TeamSkillStatus;
  hasUpdate?: boolean;
}

export interface TeamSkillPublishInput {
  slug: string;
  summary: string;
  category: TeamSkillCategory;
  whenToUse: string;
  whenNotToUse: string;
  requires?: string[] | null;
  changelog: string;
  contentHash: string;
  size?: number;
  ownerActorId?: string;
}

export interface TeamSkillsBackend {
  listTeamSkills(
    teamId: string,
    opts?: { actorId?: string; status?: TeamSkillStatus; category?: TeamSkillCategory },
  ): Promise<TeamSkill[]>;
  getTeamSkill(teamId: string, slug: string, opts?: { actorId?: string }): Promise<TeamSkillDetail>;
  publishTeamSkill(teamId: string, input: TeamSkillPublishInput): Promise<TeamSkill>;
  publishTeamSkillVersion(
    teamId: string,
    slug: string,
    input: {
      contentHash: string;
      changelog: string;
      expectedLatestVersion: number;
      publishedFromVersion?: number;
      size?: number;
    } & Partial<
      Pick<TeamSkillPublishInput, "summary" | "category" | "whenToUse" | "whenNotToUse" | "requires">
    >,
  ): Promise<TeamSkillVersion>;
  /**
   * Undo a published version by re-publishing an earlier one's content as the
   * new latest. Required before auto-follow: a bad version otherwise reaches
   * everyone within a reconcile tick with no way back.
   */
  revertTeamSkillVersion(
    teamId: string,
    slug: string,
    version: number,
    input?: { changelog?: string },
  ): Promise<TeamSkillVersion>;
  updateTeamSkill(
    teamId: string,
    slug: string,
    patch: Partial<
      Pick<
        TeamSkill,
        "summary" | "category" | "whenToUse" | "whenNotToUse" | "status" | "supersededBy" | "ownerActorId"
      >
    > & { requires?: string[] | null },
  ): Promise<TeamSkill>;
  deleteTeamSkill(teamId: string, slug: string): Promise<void>;
  installTeamSkill(
    teamId: string,
    slug: string,
    input?: { actorId?: string; version?: number; scope?: "global" | "workspace"; workspaceId?: string },
  ): Promise<TeamSkillInstall>;
  uninstallTeamSkill(teamId: string, slug: string, opts?: { actorId?: string }): Promise<void>;
  listTeamSkillInstalls(teamId: string, opts?: { actorId?: string }): Promise<TeamSkillInstall[]>;
  /**
   * Short-lived signed URL for a version's package. The bytes never pass
   * through the business API — the Rust installer fetches this directly.
   */
  resolveDownload(
    teamId: string,
    slug: string,
    version: number,
  ): Promise<{ url: string; contentHash: string; size: number }>;
  /** Upsert amuxc_blobs placeholder + optional presigned PUT for the zip. */
  prepareSkillBlob(
    teamId: string,
    input: { contentHash: string; size: number },
  ): Promise<{
    contentHash: string;
    size: number;
    ossKey: string;
    requiresUpload: boolean;
    presignedPut: string | null;
  }>;
  /** HEAD-verify OSS and mark the blob verified. */
  completeSkillBlob(
    teamId: string,
    input: { contentHash: string; size: number },
  ): Promise<{ contentHash: string; size: number; ossKey: string }>;
}

export function createTeamSkillsModule(client: CloudApiClient): TeamSkillsBackend {
  const teamPath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/skills`;
  const skillPath = (teamId: string, slug: string) =>
    `${teamPath(teamId)}/${encodeURIComponent(slug)}`;
  const blobPath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/skill-blobs`;

  return {
    async listTeamSkills(teamId, opts = {}) {
      const params = new URLSearchParams();
      if (opts.actorId) params.set("actorId", opts.actorId);
      if (opts.status) params.set("status", opts.status);
      if (opts.category) params.set("category", opts.category);
      const qs = params.toString();
      const out = await client.get<{ items: TeamSkill[] }>(
        `${teamPath(teamId)}${qs ? `?${qs}` : ""}`,
      );
      return out.items ?? [];
    },

    async getTeamSkill(teamId, slug, opts = {}) {
      const qs = opts.actorId ? `?actorId=${encodeURIComponent(opts.actorId)}` : "";
      return client.get<TeamSkillDetail>(`${skillPath(teamId, slug)}${qs}`);
    },

    async publishTeamSkill(teamId, input) {
      return client.post<TeamSkill>(teamPath(teamId), input);
    },

    async publishTeamSkillVersion(teamId, slug, input) {
      return client.post<TeamSkillVersion>(`${skillPath(teamId, slug)}/versions`, input);
    },

    async revertTeamSkillVersion(teamId, slug, version, input = {}) {
      return client.post<TeamSkillVersion>(
        `${skillPath(teamId, slug)}/versions/${version}/revert`,
        input,
      );
    },

    async updateTeamSkill(teamId, slug, patch) {
      return client.patch<TeamSkill>(skillPath(teamId, slug), patch);
    },

    async deleteTeamSkill(teamId, slug) {
      await client.delete<void>(skillPath(teamId, slug));
    },

    async installTeamSkill(teamId, slug, input = {}) {
      return client.put<TeamSkillInstall>(`${skillPath(teamId, slug)}/install`, input);
    },

    async uninstallTeamSkill(teamId, slug, opts = {}) {
      const qs = opts.actorId ? `?actorId=${encodeURIComponent(opts.actorId)}` : "";
      await client.delete<void>(`${skillPath(teamId, slug)}/install${qs}`);
    },

    async listTeamSkillInstalls(teamId, opts = {}) {
      const qs = opts.actorId ? `?actorId=${encodeURIComponent(opts.actorId)}` : "";
      const out = await client.get<{ items: TeamSkillInstall[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/skill-installs${qs}`,
      );
      return out.items ?? [];
    },

    async resolveDownload(teamId, slug, version) {
      return client.get<{ url: string; contentHash: string; size: number }>(
        `${skillPath(teamId, slug)}/versions/${version}/download`,
      );
    },

    async prepareSkillBlob(teamId, input) {
      return client.post(`${blobPath(teamId)}/prepare`, input);
    },

    async completeSkillBlob(teamId, input) {
      return client.post(`${blobPath(teamId)}/complete`, input);
    },
  };
}
