/**
 * Vanity hostnames for deployed apps: `<slug>-<id8>.<APPS_PUBLIC_DOMAIN>`.
 *
 * Why the id suffix rather than the bare slug: `apps_team_slug_uniq` makes a
 * slug unique WITHIN a team, not globally, so two teams can both own `website`
 * — and a hostname has no team in it. Eight hex characters of the app's uuid
 * make the label unique without making it unreadable.
 *
 * Why one label and not a nested one: the wildcard certificate/route covers
 * exactly one level under the domain. `a.b.<domain>` would not match
 * `*.<domain>`, so a label containing a dot is rejected rather than served
 * with a certificate that cannot exist.
 */
type Env = NodeJS.ProcessEnv;

/** Blank disables vanity hostnames entirely — the app keeps its FC trigger URL. */
export const appsPublicDomain = (env: Env = process.env) => env.APPS_PUBLIC_DOMAIN?.trim() || "";

export const ID_PREFIX_LEN = 8;

export function appPublicLabel(slug: string, appId: string): string {
  return `${slug}-${appId.slice(0, ID_PREFIX_LEN)}`;
}

/**
 * The zone the app's FC custom domain lives in, e.g. `fc-apps.example.com`.
 *
 * Deliberately a DIFFERENT zone from `APPS_PUBLIC_DOMAIN`: the public name
 * resolves to our own proxy, so if the proxy forwarded to that same name it
 * would resolve straight back to itself. This zone resolves to Function
 * Compute instead, which is how the request reaches the app at all — Node's
 * fetch cannot override `Host`, so DNS has to carry the routing.
 *
 * Blank keeps the old behaviour: the app is served on its `*.fcapp.run`
 * trigger URL, which cannot forward redirects.
 */
export const appsFcRouteDomain = (env: Env = process.env) =>
  env.APPS_FC_ROUTE_DOMAIN?.trim() || "";

/**
 * The host FC matches against to find this app's function, or null when the
 * deployment has not configured a route domain.
 *
 * Same label as the public host so the two are trivially correlatable when
 * reading logs on either side.
 */
export function appFcRouteHost(
  slug: string | null | undefined,
  appId: string | null | undefined,
  env: Env = process.env,
): string | null {
  const domain = appsFcRouteDomain(env);
  if (!domain || !slug || !appId) return null;
  return `${appPublicLabel(slug, appId)}.${domain}`;
}

/** Public URL for an app, or null when this deployment has no apps domain. */
export function appPublicUrl(
  slug: string | null | undefined,
  appId: string | null | undefined,
  env: Env = process.env,
): string | null {
  const domain = appsPublicDomain(env);
  if (!domain || !slug || !appId) return null;
  return `https://${appPublicLabel(slug, appId)}.${domain}`;
}

/**
 * Split a request's Host back into the parts that identify an app, or null
 * when the host is not a vanity app host at all (the Cloud API's own domain,
 * an IP, the container name — all of which must fall through to the API).
 */
export function parseAppPublicHost(
  host: string | null | undefined,
  env: Env = process.env,
): { slug: string; idPrefix: string } | null {
  const domain = appsPublicDomain(env);
  if (!domain || !host) return null;
  // Host carries the port on non-443 listeners; the label never does.
  const name = host.split(":")[0].trim().toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  // Exactly one level: `*.<domain>` matches `x.<domain>`, never `x.y.<domain>`.
  if (!label || label.includes(".")) return null;
  const cut = label.lastIndexOf("-");
  if (cut <= 0) return null;
  const slug = label.slice(0, cut);
  const idPrefix = label.slice(cut + 1);
  // uuid text is lowercase hex; anything else cannot be an app id prefix and
  // must not reach the database as a LIKE pattern.
  if (!new RegExp(`^[0-9a-f]{${ID_PREFIX_LEN}}$`).test(idPrefix)) return null;
  return { slug, idPrefix };
}
