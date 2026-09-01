import type { TeamSummary, TeamsBackend, TeamInviteInput, TeamInviteResult } from "../types";
import type { CloudApiClient } from "./http";

type CloudTeam = {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string | null;
  visibility?: "public" | "private";
};

type CloudMembershipTeam = {
  id: string;
  name: string;
  slug: string | null;
  orgId: string | null;
  orgName: string | null;
  visibility?: "public" | "private";
  isMember?: boolean;
  itemType?: "team" | "org";
  teamId?: string | null;
  createdAt?: string | null;
  memberCount?: number | null;
  ownerName?: string | null;
};

type CloudInvite = {
  token: string;
  inviteUrl?: string | null;
  deeplink?: string | null;
  expiresAt?: string | null;
  actorId?: string | null;
};

function mapTeam(row: CloudTeam): TeamSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt,
    visibility: row.visibility,
  };
}

function mapInvite(row: CloudInvite): TeamInviteResult {
  return {
    token: row.token,
    inviteUrl: row.inviteUrl ?? row.deeplink ?? null,
    deeplink: row.deeplink ?? null,
    expiresAt: row.expiresAt ?? null,
    actorId: row.actorId ?? null,
  };
}

type Page<T> = { items: T[]; nextCursor: string | null };

export function createTeamsModule(client: CloudApiClient): TeamsBackend {
  return {
    async listCurrentUserTeams(args = {}) {
      const limit = args.limit ?? 50;
      const page = await client.get<Page<CloudTeam>>(`/v1/teams?limit=${encodeURIComponent(String(limit))}`);
      return page.items.map(mapTeam);
    },
    async getTeam(teamId: string) {
      return mapTeam(await client.get<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}`));
    },
    async createTeam(input) {
      return mapTeam(await client.post<CloudTeam>("/v1/teams", input));
    },
    async bootstrapTeam(input = {}) {
      return mapTeam(await client.post<CloudTeam>("/v1/teams/bootstrap", input));
    },
    async renameTeam(teamId: string, name: string) {
      return mapTeam(await client.patch<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}`, { name }));
    },
    async setTeamVisibility(teamId: string, visibility: "public" | "private") {
      return mapTeam(await client.patch<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}`, { visibility }));
    },
    async joinTeam(teamId: string) {
      return mapTeam(await client.post<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}/join`, {}));
    },
    async upgradeAccount(input) {
      return client.post<{ orgId: string; teamId: string; teamName: string }>("/v1/account/upgrade", {
        teamId: input.teamId,
        orgName: input.orgName,
        contact: input.contact ?? null,
      });
    },
    async createTeamInvite(input: TeamInviteInput) {
      const kind = input.kind ?? input.actorType;
      const body = {
        teamId: input.teamId,
        kind,
        displayName: input.displayName ?? null,
        teamRole: kind === "member" ? input.teamRole : null,
        agentKind: kind === "agent" ? input.agentKind : null,
        ttlSeconds: input.ttlSeconds ?? null,
        targetActorId: input.targetActorId ?? null,
        // `in` rather than a plain read: the agent arms of TeamInviteInput have
        // no contact fields, so the union needs narrowing before access.
        inviteEmail: "inviteEmail" in input ? (input.inviteEmail ?? null) : null,
        invitePhone: "invitePhone" in input ? (input.invitePhone ?? null) : null,
      };
      return mapInvite(await client.post<CloudInvite>(`/v1/teams/${encodeURIComponent(input.teamId)}/invites`, body));
    },
    async removeTeamActor(teamId: string, actorId: string) {
      await client.delete<void>(
        `/v1/teams/${encodeURIComponent(teamId)}/actors/${encodeURIComponent(actorId)}`,
      );
    },
    async listAllMyTeams() {
      const page = await client.get<Page<CloudMembershipTeam>>(`/v1/teams?scope=all`);
      return page.items.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        orgId: r.orgId,
        orgName: r.orgName,
        visibility: r.visibility,
        isMember: r.isMember !== false,
        teamId: r.teamId ?? r.id,
        createdAt: r.createdAt ?? null,
        memberCount: r.memberCount ?? null,
        ownerName: r.ownerName ?? null,
      }));
    },
    async activateTeam(teamId: string) {
      const res = await client.post<{ actorId: string | null; teamId: string; refreshToken: string }>(
        `/v1/teams/${encodeURIComponent(teamId)}/activate`,
        {},
      );
      return { actorId: res.actorId ?? null, teamId: res.teamId, refreshToken: res.refreshToken };
    },
    async getTeamCredits(teamId) {
      return client.get(`/v1/teams/${encodeURIComponent(teamId)}/credits`);
    },
    async getCreditUsage(teamId, opts = {}) {
      const qs = new URLSearchParams();
      if (opts.range) qs.set("range", opts.range);
      if (opts.date) qs.set("date", opts.date);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return client.get(`/v1/teams/${encodeURIComponent(teamId)}/credits/usage${suffix}`);
    },
    async getCreditLedger(teamId, opts = {}) {
      const suffix = opts.limit ? `?limit=${opts.limit}` : "";
      return client.get(`/v1/teams/${encodeURIComponent(teamId)}/credits/ledger${suffix}`);
    },
    async topUpCredits(teamId, input) {
      return client.post(`/v1/teams/${encodeURIComponent(teamId)}/credits/top-up`, input);
    },
    async listCreditPackages(teamId) {
      return client.get(`/v1/teams/${encodeURIComponent(teamId)}/credits/packages`);
    },
    async createCreditCheckoutSession(teamId, input) {
      return client.post(`/v1/teams/${encodeURIComponent(teamId)}/credits/checkout-session`, input);
    },
    async getMemberQuotas(teamId) {
      return client.get(`/v1/teams/${encodeURIComponent(teamId)}/quotas`);
    },
    async setMemberQuotas(teamId, input) {
      return client.put(`/v1/teams/${encodeURIComponent(teamId)}/quotas`, input);
    },
  };
}
