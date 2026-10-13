import {
  cloudApiBaseUrl,
  CloudApiError,
  createCloudApiClient,
  supabaseAccessToken,
  type CloudApiClient,
} from "../../lib/cloud-api/client";
import { t } from "../../lib/i18n";

/**
 * Reusable team join link (#1672): one multi-use link per team, managed by
 * owners / admins, that anyone signed in can redeem without consuming a named
 * invite. Mirrors iOS `TeamJoinLink` / `InviteURL.parseJoinLink` and the
 * `CloudAPIActorRepository` join-link calls.
 */

export type TeamJoinLinkTtl = "7d" | "30d" | "never";

export type TeamJoinLinkStatus = "active" | "expired" | "exhausted" | (string & {});

export type TeamJoinLink = {
  token: string;
  url: string;
  /** ISO timestamp; null when the link never expires. */
  expiresAt: string | null;
  /** null = no cap. */
  maxUses: number | null;
  useCount: number;
  status: TeamJoinLinkStatus;
  createdAt: string;
};

export type TeamJoinLinkInput = {
  ttl: TeamJoinLinkTtl;
  maxUses: number | null;
  rotate: boolean;
};

export type JoinByLinkResult = {
  teamId: string;
  alreadyMember: boolean;
};

export type ParsedJoinLink = {
  token: string;
  /** Origin of the Cloud API that minted the link; null = this app's server. */
  cloudApiUrl: string | null;
};

const APP_SCHEMES: ReadonlySet<string> = new Set(["teamclu:", "teamclaw:", "amux:"]);

/**
 * `https://host/join/<token>` (exactly one path segment after `join`; the
 * origin is the Cloud API to redeem against), or `teamclu` / `teamclaw` /
 * `amux` with host `join`, a `token` query and an optional `cloud_api_url`.
 * Anything else — including named invites — is not a join link.
 */
export function parseJoinLink(raw: string | null | undefined): ParsedJoinLink | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol === "https:" || url.protocol === "http:") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[0] !== "join" || !parts[1]) return null;
    let token = parts[1];
    try {
      token = decodeURIComponent(token);
    } catch {
      // Keep the raw segment.
    }
    return { token, cloudApiUrl: `${url.protocol}//${url.host}` };
  }

  if (!APP_SCHEMES.has(url.protocol) || url.host !== "join") return null;
  const token = url.searchParams.get("token");
  if (!token) return null;
  const cloud = url.searchParams.get("cloud_api_url");
  return { token, cloudApiUrl: cloud ? cloud : null };
}

/**
 * The app-scheme form of a parsed link, which `parseJoinLink` reads back. Used
 * to stash a link pasted before sign-in in the pending-invite slot: it can
 * never be mistaken for a named invite token (host `join`, and it has `://`).
 */
export function formatJoinLink(link: ParsedJoinLink): string {
  const params = new URLSearchParams({ token: link.token });
  if (link.cloudApiUrl) params.set("cloud_api_url", link.cloudApiUrl);
  return `teamclu://join?${params.toString()}`;
}

/**
 * The max-uses field: empty = no cap, a whole number >= 1 = that cap, anything
 * else = invalid (iOS `parsedCap`, which returns `Int??`).
 */
export function parseJoinLinkCap(
  text: string,
): { valid: true; value: number | null } | { valid: false } {
  const trimmed = text.trim();
  if (!trimmed) return { valid: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { valid: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return { valid: false };
  return { valid: true, value };
}

/**
 * The server stores an expiry, not the term that produced it; recover the
 * term from the gap between creation and expiry (iOS `inferTtl`).
 */
export function inferJoinLinkTtl(
  link: Pick<TeamJoinLink, "expiresAt" | "createdAt">,
): TeamJoinLinkTtl {
  if (!link.expiresAt) return "never";
  const duration = Date.parse(link.expiresAt) - Date.parse(link.createdAt);
  if (!Number.isFinite(duration)) return "7d";
  const day = 24 * 60 * 60 * 1000;
  return Math.abs(duration - 30 * day) < Math.abs(duration - 7 * day) ? "30d" : "7d";
}

/** Localized copy for the 410s a dead link answers with, else null. */
export function joinLinkGoneMessage(code: string | null | undefined): string | null {
  switch (code) {
    case "link_revoked":
      return t("This join link has been revoked.");
    case "link_expired":
      return t("This join link has expired.");
    case "link_exhausted":
      return t("This join link has reached its use limit.");
    default:
      return null;
  }
}

type WireJoinLink = {
  token?: string | null;
  url?: string | null;
  expiresAt?: string | null;
  maxUses?: number | null;
  useCount?: number | null;
  status?: string | null;
  createdAt?: string | null;
};

function toJoinLink(row: WireJoinLink | null | undefined): TeamJoinLink {
  if (!row?.token || !row.url || !row.createdAt) {
    throw new Error("Join link response was incomplete.");
  }
  return {
    token: row.token,
    url: row.url,
    expiresAt: row.expiresAt ?? null,
    maxUses: typeof row.maxUses === "number" ? row.maxUses : null,
    useCount: typeof row.useCount === "number" ? row.useCount : 0,
    status: row.status ?? "active",
    createdAt: row.createdAt,
  };
}

export function joinLinkJoinPath(token: string): string {
  return `/v1/join-links/${encodeURIComponent(token)}/join`;
}

/**
 * `POST /v1/join-links/:token/join` on `client`, mapping the gone codes to
 * readable copy. Shared by the join-link API and the onboarding API.
 */
export async function redeemJoinLink(
  client: Pick<CloudApiClient, "post">,
  token: string,
): Promise<JoinByLinkResult> {
  try {
    const row = await client.post<{ teamId?: string | null; alreadyMember?: boolean } | null>(
      joinLinkJoinPath(token),
    );
    if (!row?.teamId) throw new Error("Join link returned no team.");
    return { teamId: row.teamId, alreadyMember: Boolean(row.alreadyMember) };
  } catch (error) {
    if (error instanceof CloudApiError) {
      const gone = joinLinkGoneMessage(error.code);
      if (gone) throw new CloudApiError(error.status, gone, error.code);
    }
    throw error;
  }
}

export type TeamJoinLinkApi = {
  /** The team's unrevoked link (expired / exhausted included); null when none. */
  get: (teamId: string) => Promise<TeamJoinLink | null>;
  /** Create, update, or (with `rotate`) replace the link. */
  put: (teamId: string, input: TeamJoinLinkInput) => Promise<TeamJoinLink>;
  revoke: (teamId: string) => Promise<void>;
  /**
   * Redeem a link as the signed-in user. `cloudApiUrl` targets the server that
   * minted it (same bearer), as iOS `CloudAPIClient.withBaseURL` does.
   */
  join: (token: string, cloudApiUrl?: string | null) => Promise<JoinByLinkResult>;
};

export function createTeamJoinLinkApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): TeamJoinLinkApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });
  const teamPath = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/join-link`;

  return {
    async get(teamId) {
      try {
        return toJoinLink(await client.get<WireJoinLink>(teamPath(teamId)));
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) return null;
        throw error;
      }
    },

    async put(teamId, input) {
      const row = await client.put<WireJoinLink>(teamPath(teamId), {
        ttl: input.ttl,
        maxUses: input.maxUses,
        rotate: input.rotate,
      });
      return toJoinLink(row);
    },

    async revoke(teamId) {
      await client.del(teamPath(teamId));
    },

    async join(token, cloudApiUrl) {
      const target = cloudApiUrl
        ? createCloudApiClient({
            baseUrl: cloudApiUrl,
            getAccessToken: args.getAccessToken,
            fetchImpl: args.fetchImpl,
          })
        : client;
      return redeemJoinLink(target, token);
    },
  };
}

/** Production wiring: bearer from the app's auth facade. */
export function createConfiguredTeamJoinLinkApi(
  client: Parameters<typeof supabaseAccessToken>[0],
): TeamJoinLinkApi {
  return createTeamJoinLinkApi({ getAccessToken: supabaseAccessToken(client) });
}
