import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { loadCatalog } from "./catalog.js";
import { connect } from "./db.js";
import { TokenCache, makeVerifier } from "./auth.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
// Fail fast: a half-valid catalog turns into confusing upstream errors hours
// after deploy, so every reference is resolved and every provider key checked
// before the listener opens.
const catalog = loadCatalog(cfg.catalogPath);
const sql = connect(cfg.databaseUrl);
const tokens = new TokenCache(cfg.tokenCacheTtlMs, makeVerifier(cfg));

const app = createApp({ cfg, catalog, sql, tokens });
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(
    `[ai-gateway] listening on :${info.port} — tiers: ${Object.keys(catalog.public_models).join(", ")}`,
  );
});
