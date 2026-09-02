// ---------------------------------------------------------------------------
// Default team AI gateway config, for teams that never configured one.
//
// Every team is meant to have the gateway's three tiers from day one — that is
// what the signup credit grant exists for (design §4.8). But `llm_enabled`
// defaults to false, nothing flips it when a team is created, and the
// owner-facing form that used to was removed when the tiers were pinned
// client-side (§4.3.1, a12259df). Measured on 2026-09-02: 302 of 305 teams
// held a credit balance and had no model, because the daemon only writes
// `provider.team` for `enabled=true` + a baseUrl (runtime/managed_llm.rs).
//
// So a team with no stored baseUrl is served this deployment's own gateway,
// addressed through the origin the caller reached FC on. That origin is the
// right one by construction: the daemon proxies `/v1/ai/teams/:id/*` to
// whatever baseUrl it is handed, and the gateway is mounted under `/ai/` on the
// same host as the Cloud API (Caddyfile, `handle_path /ai/*`). Deriving it from
// the request rather than a new env var keeps both deploy targets (compose and
// Serverless Devs) correct without another entry in two allowlists.
//
// An explicit `PUT /llm-config` with a baseUrl still wins — including
// `enabled=false` with a baseUrl set, which is how a team opts out. A stored
// `enabled=false` with NO baseUrl is indistinguishable from "never configured"
// (the retired form wrote exactly that for "off"), and is treated as such.
// ---------------------------------------------------------------------------
import { aiGatewayConfigured } from "./ai-gateway.js";

export type TeamLlmModel = { id: string; name: string };
export type TeamLlm = {
  enabled: boolean;
  baseUrl: string | null;
  models: TeamLlmModel[];
};

/**
 * The public tiers, in the order the desktop lists them. Mirrors
 * `TEAM_MODEL_TIERS` in packages/app/src/lib/team-provider.ts and
 * crates/teamclu-runtime-env/src/team_provider.rs. Current clients ignore the
 * served list (the ids are pinned on their side); older ones require it to be
 * non-empty before they will show the team provider at all.
 */
export const TEAM_MODEL_TIERS: readonly TeamLlmModel[] = Object.freeze([
  { id: "default", name: "标准" },
  { id: "pro", name: "高级" },
  { id: "max", name: "旗舰" },
]);

type HeaderReader = (name: string) => string | undefined | null;

function firstValue(raw: string | undefined | null): string {
  if (!raw) return "";
  const first = raw.split(",")[0];
  return first ? first.trim() : "";
}

// Hostname or IPv4 literal, with an optional port. Deliberately no IPv6
// literals and no userinfo: a caller who can put anything else in Host only
// ever changes the URL served back to themselves, but a malformed value must
// not produce a malformed baseUrl the daemon then fails on.
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:\d{1,5})?$/;

/**
 * The origin the caller reached this deployment on, from the proxy's
 * forwarding headers (Caddy sets all three by default) with `Host` as the
 * fallback for a deploy target that fronts FC directly. `null` when there is
 * no usable host — never a guess.
 */
export function requestOrigin(getHeader: HeaderReader): string | null {
  const host = firstValue(getHeader("x-forwarded-host")) || firstValue(getHeader("host"));
  if (!host || !HOST_RE.test(host)) return null;
  const proto = (firstValue(getHeader("x-forwarded-proto")) || "https").toLowerCase();
  if (proto !== "http" && proto !== "https") return null;
  return `${proto}://${host}`;
}

// Route params arrive as the RAW path segment (hono-adapter keeps them
// percent-encoded on purpose), so a plain encodeURIComponent would double-encode
// them. Normalise through a decode first; a segment that does not decode is
// encoded as-is rather than spliced raw.
function pathSegment(teamId: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(teamId));
  } catch {
    return encodeURIComponent(teamId);
  }
}

/** The gateway baseUrl for `teamId` on the deployment at `origin`. */
export function defaultTeamGatewayBaseUrl(origin: string, teamId: string): string {
  return `${origin.replace(/\/+$/, "")}/ai/v1/teams/${pathSegment(teamId)}`;
}

/**
 * The `llm` block to serve for `teamId`: the stored one when it names a
 * baseUrl (or when this deployment runs no gateway, or the request has no
 * usable origin), otherwise the deployment default. Returns `stored` by
 * reference when nothing changes, so callers can tell the two apart.
 */
export function applyTeamLlmDefaults(
  teamId: string,
  stored: TeamLlm | null | undefined,
  getHeader: HeaderReader,
): TeamLlm | null | undefined {
  const storedBaseUrl = typeof stored?.baseUrl === "string" ? stored.baseUrl.trim() : "";
  if (storedBaseUrl) return stored;
  if (!aiGatewayConfigured()) return stored;
  const origin = requestOrigin(getHeader);
  if (!origin) return stored;
  return {
    enabled: true,
    baseUrl: defaultTeamGatewayBaseUrl(origin, teamId),
    models: TEAM_MODEL_TIERS.map((m) => ({ ...m })),
  };
}

/**
 * `GET /workspace-config` response with the `llm` block defaulted. Leaves the
 * payload untouched (same reference) when the stored config stands.
 */
export function withTeamLlmDefaults<T extends { llm?: TeamLlm | null }>(
  result: T,
  teamId: string,
  getHeader: HeaderReader,
): T {
  if (!result || typeof result !== "object") return result;
  const llm = applyTeamLlmDefaults(teamId, result.llm, getHeader);
  if (llm === result.llm) return result;
  return { ...result, llm };
}
