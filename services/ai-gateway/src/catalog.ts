import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type UsageMode = "always" | "needs_stream_options";

export type Provider = {
  api_base: string;
  api_key_env: string;
  usage_mode: UsageMode;
};
export type BackendModel = {
  provider: string;
  upstream_model: string;
  default_max_output_tokens?: number;
  supported_params?: string[];
};
export type Route = { backend: string; weight?: number };
export type Pricing = { input_per_1m_credits: number; output_per_1m_credits: number };

/**
 * Image tiers are priced PER IMAGE, not per token.
 *
 * The upstream does report tokens (measured 2026-09-09: `input_tokens` 59 /
 * `output_tokens` 515 with `output_tokens_details.image_tokens`), so this is
 * not a workaround for missing data. It is that 515 "image tokens" is one whole
 * picture, a quantity not comparable to text tokens: priced at the `max` tier's
 * 80 credits/output-token it comes to ~4 credits-in-UI per image, an order of
 * magnitude off. Any token scheme would need image-specific rates anyway, so
 * pricing the image directly just removes a conversion — and makes the hold
 * exactly equal the settlement, which removes estimation entirely.
 *
 * Keys are looked up most-specific first: `<size>:<quality>`, then `<size>`,
 * then `default`. See `pricePerImage` for why a request that NAMES an unpriced
 * size is refused rather than falling back.
 */
export type ImagePricing = { per_image_credits: Record<string, number> };
export type ImageModel = {
  name: string;
  description?: string;
  routing: "priority" | "weighted" | "failover";
  pricing: ImagePricing;
  routes: Route[];
};
export type PublicModel = {
  name: string;
  description?: string;
  routing: "priority" | "weighted" | "failover";
  pricing: Pricing;
  routes: Route[];
};

export type Catalog = {
  providers: Record<string, Provider>;
  backend_models: Record<string, BackendModel>;
  public_models: Record<string, PublicModel>;
  /**
   * Image tiers, deliberately NOT in `public_models`. That map is the client
   * contract: `GET /models` serves it verbatim, `REQUIRED_TIERS` validates it,
   * and its `pricing` is per-1M-tokens. An image entry there would show up in
   * the desktop's model picker as a chat model that cannot chat.
   */
  image_models: Record<string, ImageModel>;
  default_supported_params: string[];
  default_image_params: string[];
};

/**
 * The three tiers the desktop hardcodes (design §4.3.1). A catalog missing any
 * of them would silently invalidate the model every team has selected, so the
 * gateway refuses to start rather than serve a broken menu.
 */
export const REQUIRED_TIERS = ["default", "pro", "max"] as const;

const DEFAULT_PARAMS = [
  "model", "messages", "stream", "stream_options", "temperature", "top_p",
  "max_tokens", "stop", "tools", "tool_choice", "parallel_tool_calls",
  "response_format", "seed", "n", "presence_penalty", "frequency_penalty", "user",
];

/**
 * Parse and fully validate a catalog. Throws on the first problem: a
 * half-usable catalog produces requests that fail deep in the proxy with a
 * confusing upstream error, hours after deploy.
 */
/**
 * Body keys forwarded to an images endpoint. A SEPARATE list from the chat one,
 * which does not contain `prompt` — reusing it would drop the prompt entirely
 * and send the upstream an empty request.
 */
const DEFAULT_IMAGE_PARAMS = [
  "model", "prompt", "n", "size", "quality", "background",
  "output_format", "output_compression", "moderation", "user",
];

export function parseCatalog(text: string, env: NodeJS.ProcessEnv = process.env): Catalog {
  const raw = parse(text) as Partial<Catalog> | null;
  if (!raw || typeof raw !== "object") throw new Error("catalog: not a YAML mapping");

  const providers = raw.providers ?? {};
  const backends = raw.backend_models ?? {};
  const publics = raw.public_models ?? {};

  if (!Object.keys(providers).length) throw new Error("catalog: no providers");
  if (!Object.keys(backends).length) throw new Error("catalog: no backend_models");

  for (const [id, p] of Object.entries(providers)) {
    if (!p?.api_base) throw new Error(`catalog: provider ${id} has no api_base`);
    if (!p?.api_key_env) throw new Error(`catalog: provider ${id} has no api_key_env`);
    if (p.usage_mode !== "always" && p.usage_mode !== "needs_stream_options") {
      throw new Error(
        `catalog: provider ${id} usage_mode must be "always" or "needs_stream_options"`,
      );
    }
    if (!env[p.api_key_env]?.trim()) {
      throw new Error(`catalog: provider ${id} needs ${p.api_key_env} in the environment`);
    }
  }

  for (const [id, b] of Object.entries(backends)) {
    if (!providers[b?.provider]) {
      throw new Error(`catalog: backend ${id} references unknown provider ${b?.provider}`);
    }
    if (!b?.upstream_model) throw new Error(`catalog: backend ${id} has no upstream_model`);
  }

  for (const [id, m] of Object.entries(publics)) {
    if (!m?.routes?.length) throw new Error(`catalog: public model ${id} has no routes`);
    for (const r of m.routes) {
      if (!backends[r?.backend]) {
        throw new Error(`catalog: public model ${id} routes to unknown backend ${r?.backend}`);
      }
    }
    const pr = m.pricing;
    if (!pr || !Number.isFinite(pr.input_per_1m_credits) || !Number.isFinite(pr.output_per_1m_credits)) {
      throw new Error(`catalog: public model ${id} needs numeric pricing (see §4.4)`);
    }
    if (pr.input_per_1m_credits < 0 || pr.output_per_1m_credits < 0) {
      throw new Error(`catalog: public model ${id} has negative pricing`);
    }
  }

  const images = raw.image_models ?? {};
  for (const [id, m] of Object.entries(images)) {
    if (!m?.routes?.length) throw new Error(`catalog: image model ${id} has no routes`);
    for (const r of m.routes) {
      if (!backends[r?.backend]) {
        throw new Error(`catalog: image model ${id} routes to unknown backend ${r?.backend}`);
      }
    }
    const per = m.pricing?.per_image_credits;
    if (!per || typeof per !== "object") {
      throw new Error(`catalog: image model ${id} needs pricing.per_image_credits`);
    }
    // A missing `default` is how an image tier ends up serving for free: every
    // lookup falls through to it, so its absence is not a partial catalog, it
    // is an unpriced product.
    if (!Number.isFinite(per.default)) {
      throw new Error(`catalog: image model ${id} needs pricing.per_image_credits.default`);
    }
    for (const [k, v] of Object.entries(per)) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(
          `catalog: image model ${id} price "${k}" must be a positive integer (got ${v})`,
        );
      }
    }
  }

  for (const tier of REQUIRED_TIERS) {
    if (!publics[tier]) {
      throw new Error(
        `catalog: public model "${tier}" is required — the desktop hardcodes the ` +
          `default/pro/max tiers, so omitting one invalidates every team that picked it`,
      );
    }
  }

  return {
    providers,
    backend_models: backends,
    public_models: publics,
    image_models: images,
    default_supported_params: raw.default_supported_params ?? DEFAULT_PARAMS,
    default_image_params: raw.default_image_params ?? DEFAULT_IMAGE_PARAMS,
  };
}

export function loadCatalog(path: string, env: NodeJS.ProcessEnv = process.env): Catalog {
  return parseCatalog(readFileSync(path, "utf8"), env);
}

/** Pick one route for this request. Unknown ids are the caller's problem. */
export function pickRoute(cat: Catalog, publicId: string, attempt = 0) {
  return pickFrom(cat, cat.public_models[publicId], attempt);
}

/** Same, for an image tier. Image and chat tiers share routing semantics. */
export function pickImageRoute(cat: Catalog, imageId: string, attempt = 0) {
  return pickFrom(cat, cat.image_models[imageId], attempt);
}

function pickFrom(
  cat: Catalog,
  m: { routing: PublicModel["routing"]; routes: Route[] } | undefined,
  attempt: number,
): { backendId: string; backend: BackendModel; provider: Provider } | null {
  if (!m) return null;
  let route: Route | undefined;
  if (m.routing === "weighted" && m.routes.length > 1) {
    const total = m.routes.reduce((s, r) => s + (r.weight ?? 1), 0);
    let x = Math.random() * total;
    for (const r of m.routes) {
      x -= r.weight ?? 1;
      if (x <= 0) { route = r; break; }
    }
    route ??= m.routes[0];
  } else {
    // priority and failover both walk the list in order; failover advances the
    // attempt index when the previous upstream errored.
    route = m.routes[Math.min(attempt, m.routes.length - 1)];
  }
  const backend = cat.backend_models[route.backend];
  return { backendId: route.backend, backend, provider: cat.providers[backend.provider] };
}
