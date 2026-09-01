/** Process configuration. Every value is read once, at startup. */
export type Config = {
  port: number;
  databaseUrl: string;
  catalogPath: string;
  serviceToken: string;
  /** Which auth path FC is on; the gateway copies its behaviour. See auth.ts. */
  backendKind: "supabase" | "postgres";
  supabaseUrl: string;
  supabaseAnonKey: string;
  authBaseUrl: string;
  /** How long a verified token -> sub mapping is trusted. */
  tokenCacheTtlMs: number;
  /**
   * Whether a request can be REFUSED for lack of credits.
   *
   * Off by default, and that is the safe direction. Metering runs either way;
   * this only decides whether an empty balance blocks. Turning it on before
   * existing teams are back-filled with a starting grant 402s every team at
   * once, so the rollout order is: deploy metering, back-fill, then flip this.
   * See §4.8.1 of the design.
   */
  creditsEnforced: boolean;
};

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backendKind = env.BACKEND_KIND === "postgres" ? "postgres" : "supabase";
  return {
    port: Number(env.PORT || 4001),
    databaseUrl: req("DATABASE_URL"),
    catalogPath: env.CATALOG_PATH?.trim() || "/app/catalog.yaml",
    serviceToken: req("AI_GATEWAY_SERVICE_TOKEN"),
    backendKind,
    // Only the supabase path needs these; fail loudly at startup rather than on
    // the first request, which is how a mis-set env becomes a 3am page.
    supabaseUrl: backendKind === "supabase" ? req("SUPABASE_URL") : "",
    supabaseAnonKey: backendKind === "supabase" ? req("SUPABASE_ANON_KEY") : "",
    authBaseUrl: env.AUTH_BASE_URL?.trim() || "",
    tokenCacheTtlMs: Number(env.TOKEN_CACHE_TTL_MS || 60_000),
    creditsEnforced: env.CREDITS_ENFORCED === "true" || env.CREDITS_ENFORCED === "1",
  };
}
