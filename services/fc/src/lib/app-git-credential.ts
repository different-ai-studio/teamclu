import { ApiError } from "./http-utils.js";

/**
 * A stored HTTPS credential for an imported app's repo.
 *
 * An imported repo lives on someone else's forge, so this deployment cannot
 * mint a key for it the way it does for a Gitea-managed one. What it can do is
 * keep the token the app's admin typed, sealed in `amux.app_secrets`, and hand
 * it to the same callers `GET /v1/apps/:id/git-credential` already serves a
 * deploy key to: the machines that clone the repo and the agents that pull it.
 */

/** `apps.git_auth_kind` for an imported http(s) repo with a stored token. */
export const GIT_HTTPS_AUTH_KIND = "https_token";

/**
 * `app_secrets.kind` the token is sealed under. The kind is the AAD, so the
 * row cannot be replayed as any other secret the app holds.
 */
export const APP_GIT_HTTPS_CREDENTIAL_KIND = "git_https_credential";

/**
 * Username sent when the admin leaves it blank. GitHub and GitLab read only the
 * token and accept any non-empty name; the forges that do check it (Gitee,
 * Bitbucket) need it typed.
 */
export const DEFAULT_GIT_HTTPS_USERNAME = "x-access-token";

const MAX_USERNAME_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4096;

export interface GitHttpsCredential {
  username: string;
  token: string;
}

/** Whether `url` is an http(s) address — the only kind a token authenticates. */
export function isHttpGitRemote(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

function parseField(raw: unknown, name: string, maxLength: number, required: boolean): string {
  if (raw === undefined || raw === null) {
    if (required) throw new ApiError(400, "validation_failed", `${name} is required`);
    return "";
  }
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", `${name} must be a string`);
  }
  // Trimmed: a token copied out of a forge's settings page often brings a
  // trailing newline with it, and no forge issues one that starts or ends in
  // whitespace.
  const value = raw.trim();
  if (required && !value) throw new ApiError(400, "validation_failed", `${name} is required`);
  // git's credential protocol is one `key=value` per line. A line break inside
  // either field would end the answer early and let the rest be read as another
  // attribute.
  if (/[\r\n\0]/.test(value)) {
    throw new ApiError(400, "validation_failed", `${name} must not contain newlines or NUL`);
  }
  if (value.length > maxLength) {
    throw new ApiError(400, "validation_failed", `${name} is longer than ${maxLength} characters`);
  }
  return value;
}

/** Validate a `PUT /v1/apps/:id/git-credential` body. */
export function parseGitHttpsCredentialInput(body: unknown): GitHttpsCredential {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const token = parseField(input.token, "token", MAX_TOKEN_LENGTH, true);
  const username = parseField(input.username, "username", MAX_USERNAME_LENGTH, false);
  return { username: username || DEFAULT_GIT_HTTPS_USERNAME, token };
}

/** The plaintext that gets sealed. */
export function serializeGitHttpsCredential(credential: GitHttpsCredential): string {
  return JSON.stringify({ username: credential.username, token: credential.token });
}

/** Read a sealed credential back; null when the plaintext is not one. */
export function deserializeGitHttpsCredential(plaintext: string): GitHttpsCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const value = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (typeof value.token !== "string" || !value.token) return null;
  const username =
    typeof value.username === "string" && value.username ? value.username : DEFAULT_GIT_HTTPS_USERNAME;
  return { username, token: value.token };
}
