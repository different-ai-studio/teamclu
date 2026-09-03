import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import type { TeamSkill, TeamSkillCategory } from "@/lib/backend/cloud-api/team-skills";

/**
 * First-party skills marketplace client.
 *
 * Design: docs/architecture/skills-marketplace.md
 *
 * The marketplace is a second writer into the team skills registry (§3): an
 * item here becomes a `team_skills` row via `adoptTeamSkill`, and everything
 * after that — install, auto-follow, version history — is the existing
 * registry machinery (`team-skills.ts`). This module only owns the read-only
 * catalog and the one write that creates the subscription.
 */

/** Present on a catalog row only when the caller passed `teamId` (§6). */
interface AdoptedByTeam {
  /** The team's own slug for this skill — may differ from the catalog slug (§8.1). */
  slug: string;
  latestVersion: number;
  upstreamSubscribed: boolean;
}

export interface MarketplaceSkill {
  id: string;
  slug: string;
  displayName: string;
  /** First-party publisher label — never a user (§4.1). */
  publisher: string;
  summary: string;
  category: TeamSkillCategory;
  whenToUse: string;
  whenNotToUse: string;
  requires: string[] | null;
  tags: string[];
  status: "draft" | "published" | "delisted";
  latestVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  adoptedByTeam?: AdoptedByTeam | null;
}

interface MarketplaceSkillVersion {
  version: number;
  contentHash: string;
  size: number;
  objectPath: string;
  changelog: string;
  summary: string;
  whenToUse: string;
  whenNotToUse: string;
  requires: string[] | null;
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface MarketplaceSimilarSkill {
  slug: string;
  summary: string;
}

export interface MarketplaceSkillDetail extends MarketplaceSkill {
  /** Counted from `team_skills`, not a stored column (§4.1). */
  adoptCount: number;
  versions: MarketplaceSkillVersion[];
}

export interface MarketplaceBackend {
  listMarketplaceSkills(opts?: {
    q?: string;
    category?: TeamSkillCategory;
    teamId?: string;
    /** Cap the page. Used by callers that only need existence, not content. */
    limit?: number;
  }): Promise<MarketplaceSkill[]>;
  getMarketplaceSkill(
    slug: string,
    opts?: { teamId?: string },
  ): Promise<MarketplaceSkillDetail>;
  /**
   * Creates a `team_skills` row in subscription state and installs v1 for the
   * caller. Zero bytes move through this call — the bytes already live in the
   * marketplace object namespace (§8.1).
   */
  adoptTeamSkill(
    teamId: string,
    input: { marketplaceSlug: string; slug?: string; version?: number },
  ): Promise<TeamSkill & { similarSkills: MarketplaceSimilarSkill[] }>;
  /** Stops following upstream; the team keeps the skill at its current version (§7.2). */
  detachTeamSkill(teamId: string, slug: string): Promise<TeamSkill>;
}

export function createMarketplaceModule(client: CloudApiClient): MarketplaceBackend {
  const basePath = "/v1/marketplace/skills";
  const skillPath = (slug: string) => `${basePath}/${encodeURIComponent(slug)}`;
  const teamPath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/skills`;

  return {
    async listMarketplaceSkills(opts = {}) {
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.category) params.set("category", opts.category);
      if (opts.teamId) params.set("teamId", opts.teamId);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const out = await client.get<{ items: MarketplaceSkill[] }>(
        `${basePath}${qs ? `?${qs}` : ""}`,
      );
      return out.items ?? [];
    },

    async getMarketplaceSkill(slug, opts = {}) {
      const qs = opts.teamId ? `?teamId=${encodeURIComponent(opts.teamId)}` : "";
      return client.get<MarketplaceSkillDetail>(`${skillPath(slug)}${qs}`);
    },

    async adoptTeamSkill(teamId, input) {
      return client.post(`${teamPath(teamId)}/adopt`, input);
    },

    async detachTeamSkill(teamId, slug) {
      return client.post(`${teamPath(teamId)}/${encodeURIComponent(slug)}/detach`, {});
    },
  };
}
