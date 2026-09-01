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
  default_supported_params: string[];
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
    default_supported_params: raw.default_supported_params ?? DEFAULT_PARAMS,
  };
}

export function loadCatalog(path: string, env: NodeJS.ProcessEnv = process.env): Catalog {
  return parseCatalog(readFileSync(path, "utf8"), env);
}

/** Pick one route for this request. Unknown ids are the caller's problem. */
export function pickRoute(cat: Catalog, publicId: string, attempt = 0): { backendId: string; backend: BackendModel; provider: Provider } | null {
  const m = cat.public_models[publicId];
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
