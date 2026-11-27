// WeCom domain-ownership check. Before it accepts a domain for 登录授权 or as a
// trusted domain, the provider console fetches
// `https://<domain>/WW_verify_<code>.txt` and expects the body `<code>`.
//
// Only codes listed in WECOM_DOMAIN_VERIFY_CODES are answered. Echoing whatever
// code the filename carries would let any WeCom provider prove they own our
// API domain.
const FILE_RE = /^WW_verify_([A-Za-z0-9]{8,64})\.txt$/;

export function wecomDomainVerifyBody(file: string, env: Record<string, string | undefined>): string | null {
  const m = FILE_RE.exec(file);
  if (!m) return null;
  const allowed = (env.WECOM_DOMAIN_VERIFY_CODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(m[1]) ? m[1] : null;
}
