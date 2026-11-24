// Web handoff — sign the caller into a partner web console (a supabase-js SPA
// on the same GoTrue) without handing it TeamClu's own tokens.
//
// FC mints a one-time magic-link token_hash for the caller and answers the
// console's own `/session?redirect=<path>#token_hash=<hash>` page, which signs
// out locally and verifies the hash into a session of its own. The console's
// session then refreshes on its own token family, so neither side can rotate
// the other's refresh token away (sharing one refresh token across two clients
// logs both out on the first reuse).
//
// Which hosts qualify is WEB_HANDOFF_HOSTS, a comma-separated host list. Empty
// (the default) turns the feature off: every URL answers "no handoff".

export function webHandoffHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.WEB_HANDOFF_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface WebHandoffTarget {
  /** `https://host[:port]` of the console. */
  origin: string;
  /** Path + query to land on after sign-in; always starts with a single `/`. */
  redirect: string;
}

/**
 * The console origin and in-app redirect for `rawUrl`, or null when the URL is
 * not one this deployment hands sessions to: unparsable, not https, carrying
 * credentials, or a host outside the allowlist.
 */
export function resolveWebHandoffTarget(rawUrl: unknown, hosts: Set<string>): WebHandoffTarget | null {
  if (typeof rawUrl !== "string" || hosts.size === 0) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!hosts.has(url.host.toLowerCase())) return null;
  // URL normalises the pathname to start with "/", but a leading "//" or "/\"
  // would make the console's redirect protocol-relative — an open redirect.
  const path = url.pathname.replace(/^[/\\]+/, "/");
  const redirect = `${path}${url.search}`;
  return { origin: url.origin, redirect };
}

export function buildWebHandoffUrl(target: WebHandoffTarget, tokenHash: string): string {
  return `${target.origin}/session?redirect=${encodeURIComponent(target.redirect)}#token_hash=${encodeURIComponent(tokenHash)}`;
}
