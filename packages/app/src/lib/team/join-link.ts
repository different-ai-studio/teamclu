import { appScheme } from "@/lib/config/build-config";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";
import { useCurrentTeamStore } from "@/stores/current-team";

// Same scheme rules as invite-deeplink: OS delivery is this build's scheme;
// pasted input also accepts the `amux:` links the RPC still emits.
const CUSTOM_SCHEMES: ReadonlySet<string> = new Set([`${appScheme}:`, "amux:"]);
const JOIN_HOST = "join";
const CLOUD_API_PARAM = "cloud_api_url";

export const JOIN_LINK_GONE_MESSAGES = {
  link_revoked: "这条链接已停用",
  link_expired: "这条链接已过期",
  link_exhausted: "这条链接已达到人数上限",
} as const;

export type JoinLinkGoneCode = keyof typeof JOIN_LINK_GONE_MESSAGES;

export interface ParsedJoinLink {
  token: string;
  cloudApiUrl: string | null;
}

export interface JoinLinkPreview {
  teamName: string;
  inviterDisplayName: string;
  expiresAt: string | null;
  status: string;
}

export interface JoinLinkRedeemResult {
  teamId: string;
  alreadyMember: boolean;
}

export function joinLinkGoneMessage(code: string | null | undefined): string | null {
  if (code === "link_revoked" || code === "link_expired" || code === "link_exhausted") {
    return JOIN_LINK_GONE_MESSAGES[code];
  }
  return null;
}

/** Origin used for both preview and join. Never send them to different hosts. */
export function resolveJoinLinkOrigin(cloudApiUrl: string | null): string | null {
  const raw = (cloudApiUrl ?? getEffectiveServerConfigSync().cloudApiUrl ?? "").replace(/\/+$/, "");
  return raw || null;
}

export function parseJoinLink(raw: string): ParsedJoinLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2 || parts[0] !== JOIN_HOST || !parts[1]) return null;
      return { token: decodeURIComponent(parts[1]), cloudApiUrl: url.origin };
    }
    if (!CUSTOM_SCHEMES.has(url.protocol)) return null;
    if (url.hostname !== JOIN_HOST && url.pathname !== `//${JOIN_HOST}`) return null;
    const token = url.searchParams.get("token");
    if (!token) return null;
    return { token, cloudApiUrl: url.searchParams.get(CLOUD_API_PARAM) || null };
  } catch {
    return null;
  }
}

class JoinLinkHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "JoinLinkHttpError";
    this.status = status;
    this.code = code;
  }
}

function errorCodeFromBody(data: unknown): string {
  if (!data || typeof data !== "object") return "internal";
  const record = data as { error?: { code?: unknown }; code?: unknown };
  if (typeof record.error?.code === "string") return record.error.code;
  if (typeof record.code === "string") return record.code;
  return "internal";
}

async function readJoinLinkResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new JoinLinkHttpError(
      response.status,
      errorCodeFromBody(data),
      joinLinkGoneMessage(errorCodeFromBody(data)) ?? "Join link request failed.",
    );
  }
  return data as T;
}

export async function previewJoinLink(origin: string, token: string): Promise<JoinLinkPreview> {
  const response = await fetch(`${origin}/v1/join-links/${encodeURIComponent(token)}`);
  return readJoinLinkResponse<JoinLinkPreview>(response);
}

export async function joinTeamByLink(
  origin: string,
  token: string,
  accessToken: string,
): Promise<JoinLinkRedeemResult> {
  const response = await fetch(`${origin}/v1/join-links/${encodeURIComponent(token)}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return readJoinLinkResponse<JoinLinkRedeemResult>(response);
}

const redeemOnce = new Map<string, Promise<JoinLinkRedeemResult>>();
// The promise bootstrap awaits. Set synchronously, before the POST.
let inFlightJoin: Promise<JoinLinkRedeemResult> | null = null;
let successfulJoin: JoinLinkRedeemResult | null = null;
// Bumped on sign-out so a redeem that finishes afterwards cannot satisfy
// the next person's team bootstrap.
let joinEpoch = 0;

function redeemKey(link: ParsedJoinLink): string {
  return `${link.token}\0${link.cloudApiUrl ?? ""}`;
}

export function currentJoinLinkRedeem(): Promise<JoinLinkRedeemResult> | null {
  return inFlightJoin;
}

export function successfulJoinLinkRedeem(): JoinLinkRedeemResult | null {
  return successfulJoin;
}

export function clearSuccessfulJoinLinkRedeem(): void {
  successfulJoin = null;
  joinEpoch += 1;
}

export async function redeemAcceptedJoinLink(
  link: ParsedJoinLink,
  accessToken: string,
): Promise<JoinLinkRedeemResult> {
  const origin = resolveJoinLinkOrigin(link.cloudApiUrl);
  if (!origin) throw new Error("Cloud API URL is not configured");
  const result = await joinTeamByLink(origin, link.token, accessToken);
  await useCurrentTeamStore.getState().enterTeam(result.teamId);
  return result;
}

/**
 * One POST per accepted link, shared by the dialog and AuthGate.
 *
 * The returned promise is stored before any fetch. Callers can pass the
 * access-token promise itself so registration happens before that await too.
 */
export function redeemAcceptedJoinLinkOnce(
  link: ParsedJoinLink,
  accessToken: string | Promise<string>,
): Promise<JoinLinkRedeemResult> {
  const key = redeemKey(link);
  const existing = redeemOnce.get(key);
  if (existing) return existing;

  let resolveRedeem!: (result: JoinLinkRedeemResult) => void;
  let rejectRedeem!: (error: unknown) => void;
  const promise = new Promise<JoinLinkRedeemResult>((resolve, reject) => {
    resolveRedeem = resolve;
    rejectRedeem = reject;
  });
  redeemOnce.set(key, promise);
  inFlightJoin = promise;
  const epoch = joinEpoch;

  void (async () => {
    try {
      const token = await accessToken;
      const result = await redeemAcceptedJoinLink(link, token);
      if (epoch === joinEpoch) successfulJoin = result;
      resolveRedeem(result);
    } catch (error) {
      if (inFlightJoin === promise) inFlightJoin = null;
      if (redeemOnce.get(key) === promise) redeemOnce.delete(key);
      rejectRedeem(error);
    }
  })();

  return promise;
}

export function resetJoinLinkRedeemForTests(): void {
  redeemOnce.clear();
  inFlightJoin = null;
  successfulJoin = null;
  joinEpoch = 0;
}

export { JoinLinkHttpError };
