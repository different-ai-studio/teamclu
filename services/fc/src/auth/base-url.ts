// AUTH_BASE_URL is the issuer/audience of the tokens FC mints for a deployed
// app running with platform auth, and the API_BASE that app is handed
// (lib/provisioning/app-auth-mode.ts).
//
// It used to default to a hosted host that has since been deleted, so a blank
// env var meant minting tokens with a bogus issuer against a domain nobody
// controls — failing in a way that looks like a token bug. There is no sane
// default for "who issued this token", so fail closed.
export function authBaseURL(explicit?: string | null): string {
  const url = (explicit ?? process.env.AUTH_BASE_URL)?.trim();
  if (!url) {
    throw new Error(
      "AUTH_BASE_URL is not set. It is the JWT issuer/audience for app platform auth — set it to this deployment's Cloud API origin (self-host: https://api.teamclu-dev.ucar.cc).",
    );
  }
  return url;
}
