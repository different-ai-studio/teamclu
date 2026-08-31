import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { loadCatalog } from "./catalog.js";
import { connect } from "./db.js";
import { TokenCache, makeVerifier } from "./auth.js";
import { createApp } from "./app.js";
import { sweepExpired } from "./credits.js";

const cfg = loadConfig();
// Fail fast: a half-valid catalog turns into confusing upstream errors hours
// after deploy, so every reference is resolved and every provider key checked
// before the listener opens.
const catalog = loadCatalog(cfg.catalogPath);
const sql = connect(cfg.databaseUrl);
const tokens = new TokenCache(cfg.tokenCacheTtlMs, makeVerifier(cfg));

// Orphaned holds (crashed process, client vanished mid-stream) would keep
// credit reserved forever. Sweeping is cheap — one partial-index update — so it
// runs often enough that a stuck hold is a blip rather than an outage.
if (cfg.creditsEnforced) {
  setInterval(() => {
    sweepExpired(sql)
      .then((n) => n > 0 && console.log(`[credits] released ${n} expired hold(s)`))
      .catch((e) => console.error("[credits] sweep failed", e));
  }, 60_000).unref();
}

const app = createApp({ cfg, catalog, sql, tokens });
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(
    `[ai-gateway] listening on :${info.port} — tiers: ${Object.keys(catalog.public_models).join(", ")}`,
  );
});
