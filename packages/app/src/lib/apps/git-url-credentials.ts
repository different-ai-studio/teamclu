/** Whether a repo address is reached over http(s) — the only kind a token authenticates. */
export function isHttpGitUrl(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())
}

/**
 * Token prefixes the big forges issue. A lone userinfo that starts with one
 * is GitHub's token-only form (`https://ghp_…@github.com/…`); anything else
 * there is a username, which is what Bitbucket's own clone button puts in.
 */
const TOKEN_PREFIXES = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)/

function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * Split the credentials out of a pasted http(s) repo address.
 *
 * `https://user:token@host/owner/repo.git` is how people are used to cloning a
 * private repo, so they paste it. The server strips that part before storing
 * the address, and git would write the rest into `.git/config` in plain text —
 * so the form lifts it out and stores it the way the credential fields do.
 *
 * Anything that is not http(s) comes back untouched: for ssh the `git@` part
 * is the address, not a secret.
 */
export function splitGitUrlCredentials(raw: string): {
  url: string
  username: string
  token: string
} {
  const url = raw.trim()
  const match = /^(https?:\/\/)([^/?#]*)(.*)$/i.exec(url)
  if (!match) return { url, username: '', token: '' }
  const [, scheme, authority, rest] = match
  // Last `@`, as the server does: a password should percent-encode one, and a
  // split on the first would cut the host off a sloppy-but-working URL.
  const at = authority.lastIndexOf('@')
  if (at < 0) return { url, username: '', token: '' }
  const userinfo = authority.slice(0, at)
  const stripped = `${scheme}${authority.slice(at + 1)}${rest}`
  const colon = userinfo.indexOf(':')
  if (colon < 0) {
    const lone = decode(userinfo)
    return TOKEN_PREFIXES.test(lone)
      ? { url: stripped, username: '', token: lone }
      : { url: stripped, username: lone, token: '' }
  }
  return {
    url: stripped,
    username: decode(userinfo.slice(0, colon)),
    token: decode(userinfo.slice(colon + 1)),
  }
}
