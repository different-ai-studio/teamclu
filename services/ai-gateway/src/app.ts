import { Hono } from "hono";
import type { Config } from "./config.js";
import type { Catalog } from "./catalog.js";
import { pickRoute } from "./catalog.js";
import { TokenCache, bearer } from "./auth.js";
import { resolveActor, recordUsage, getBalance, type Sql } from "./db.js";
import { computeCredits, prepareUpstream, readUsage, teeSseUsage } from "./proxy.js";
import { release, reserve, settle } from "./credits.js";

export type Deps = {
  cfg: Config;
  catalog: Catalog;
  sql: Sql;
  tokens: TokenCache;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

const err = (code: string, message: string, status: number) =>
  ({ error: { code, message } }) as const;

/**
 * Output ceiling to size a hold with when the request names none. Takes the
 * largest across the tier's routes: the hold has to cover whichever backend the
 * request actually lands on.
 */
function defaultMaxOutput(catalog: Catalog, publicId: string): number {
  const tier = catalog.public_models[publicId];
  if (!tier) return 16_000;
  const caps = tier.routes.map(
    (r) => catalog.backend_models[r.backend]?.default_max_output_tokens ?? 16_000,
  );
  return caps.length ? Math.max(...caps) : 16_000;
}

export function createApp(deps: Deps) {
  const { cfg, catalog, sql, tokens } = deps;
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ── caller identity + membership ─────────────────────────────────────────
  // The :teamId in the path is untrusted. A token proves who you are; only the
  // actors lookup proves you may spend this team's credits (design §6.2).
  const authed = async (c: any) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return { error: c.json(err("unauthorized", "bearer token required", 401), 401) };
    let sub: string;
    try {
      sub = await tokens.resolve(token);
    } catch {
      return { error: c.json(err("invalid_token", "invalid or expired access token", 401), 401) };
    }
    const teamId = c.req.param("teamId");
    if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
      return { error: c.json(err("invalid_request", "teamId must be a uuid", 400), 400) };
    }
    const actor = await resolveActor(sql, teamId, sub);
    if (!actor) {
      return { error: c.json(err("not_a_team_member", "caller is not a member of this team", 403), 403) };
    }
    return { teamId, actor };
  };

  app.get("/v1/teams/:teamId/models", async (c) => {
    const a = await authed(c);
    if ("error" in a) return a.error;
    return c.json({
      object: "list",
      data: Object.entries(catalog.public_models).map(([id, m]) => ({
        id,
        name: m.name,
        description: m.description ?? null,
        // Exact, not an estimate: we set the tier price ourselves, so the
        // billing screen can convert credits to tokens without hedging (§12.3).
        pricing: {
          inputPer1mCredits: m.pricing.input_per_1m_credits,
          outputPer1mCredits: m.pricing.output_per_1m_credits,
        },
      })),
    });
  });

  app.get("/v1/teams/:teamId/credits/balance", async (c) => {
    const a = await authed(c);
    if ("error" in a) return a.error;
    return c.json({ teamId: a.teamId, balanceCredits: await getBalance(sql, a.teamId) });
  });

  app.post("/v1/teams/:teamId/chat/completions", async (c) => {
    const a = await authed(c);
    if ("error" in a) return a.error;
    const started = Date.now();

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(err("invalid_request", "body must be JSON", 400), 400);
    }

    const publicId = String(body.model ?? "");
    const tier = catalog.public_models[publicId];
    if (!tier) {
      // Never fall back to `default`: a client sent the wrong id and would
      // otherwise sit on the wrong tier indefinitely with no signal (§4.3.2).
      return c.json(
        err("model_not_allowed", `unknown model "${publicId}"`, 403),
        403,
      );
    }

    // Conservative hold: the tier's own price against an upper bound on the
    // request. Input is estimated from raw byte length rather than tokenised —
    // over-estimating is free (the hold is released) while under-estimating
    // lets a request through that the balance cannot cover.
    //
    // Output is estimated at the full ceiling because reasoning tokens count
    // toward completion_tokens and can consume the entire budget on their own.
    const wantsStream = body.stream === true;
    const estInput = Math.ceil(JSON.stringify(body.messages ?? "").length / 3);
    const estOutput = Number(body.max_tokens ?? 0) || defaultMaxOutput(catalog, publicId);
    const hold = computeCredits(tier.pricing, estInput, estOutput);

    let reservationId: string | null = null;
    if (cfg.creditsEnforced) {
      const held = await reserve(sql, {
        teamId: a.teamId,
        actorId: a.actor.id,
        actorType: a.actor.actorType,
        holdCredits: hold,
      });
      if (!held.ok) {
        // Distinct codes on purpose: `insufficient_credits` stops the whole
        // team and is fixed by topping up, `quota_exceeded` stops one member
        // and is fixed by raising their limit. Collapsing them into one
        // message sends people to the wrong remedy.
        return c.json(err(held.code, held.message, 402), 402);
      }
      reservationId = held.reservationId;
    }
    const clientAskedForUsage =
      (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;

    const maxAttempts = tier.routing === "failover" ? tier.routes.length : 1;
    let lastStatus = 502;
    let lastText = "upstream unavailable";

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const picked = pickRoute(catalog, publicId, attempt);
      if (!picked) break;
      const apiKey = env[picked.provider.api_key_env] ?? "";
      const prepared = prepareUpstream(
        catalog, picked.provider, picked.backendId, picked.backend, body, apiKey, c.req.raw.signal,
      );

      let res: Response;
      try {
        res = await doFetch(prepared.url, prepared.init);
      } catch (e) {
        lastStatus = 502;
        lastText = `upstream request failed: ${(e as Error).message}`;
        continue;
      }

      if (!res.ok) {
        lastStatus = res.status;
        lastText = await res.text();
        // Only failover retries; a 4xx from a healthy upstream is the client's
        // problem and retrying it just burns another call.
        if (tier.routing === "failover" && res.status >= 500) continue;
        // Pass the upstream error through verbatim — agent runtimes depend on
        // these semantics — and do not settle anything. The hold has to go
        // back, though: the customer got no tokens, so charging or holding
        // against a failed call is money they never spent.
        await release(sql, reservationId).catch(() => {});
        return new Response(lastText, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
        });
      }

      const log = async (
        u: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null,
        source: "upstream" | "estimated",
      ) => {
        const credits = u ? computeCredits(tier.pricing, u.inputTokens, u.outputTokens) : 0;
        const usageLogId = await recordUsage(sql, {
          teamId: a.teamId,
          actorId: a.actor.id,
          publicModelId: publicId,
          backendModelId: picked.backendId,
          providerId: picked.backend.provider,
          inputTokens: u?.inputTokens ?? 0,
          cachedInputTokens: u?.cachedInputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          credits,
          usageSource: source,
          statusCode: res.status,
          stream: wantsStream,
          latencyMs: Date.now() - started,
          requestId: c.req.header("x-request-id") ?? null,
        });
        if (!cfg.creditsEnforced) return;
        // No usage row means the charge cannot be attributed, so release the
        // hold rather than debit something the ledger cannot point at.
        if (usageLogId) {
          await settle(sql, {
            reservationId,
            teamId: a.teamId,
            actorId: a.actor.id,
            credits,
            usageLogId,
          }).catch((e) => console.error("[credits] settle failed", e));
        } else {
          await release(sql, reservationId).catch(() => {});
        }
      };

      if (!wantsStream || !res.body) {
        const json = await res.json().catch(() => null);
        const usage = readUsage(json);
        void log(usage, usage ? "upstream" : "estimated");
        return c.json(json as any, res.status as any);
      }

      let seen: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null = null;
      const stream = teeSseUsage(res.body, {
        dropUsageOnlyFrame: prepared.injectedUsageOption && !clientAskedForUsage,
        onUsage: (u) => { seen = u; },
      });
      // The usage frame is the last thing on the wire, so the log write is
      // queued after the stream drains rather than before it starts.
      const done = new TransformStream<Uint8Array, Uint8Array>({
        flush() { void log(seen, seen ? "upstream" : "estimated"); },
      });
      return new Response(stream.pipeThrough(done), {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("content-type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    await release(sql, reservationId).catch(() => {});
    return c.json(err("upstream_error", lastText.slice(0, 500), lastStatus), lastStatus as any);
  });

  // ── internal (FC service token) ──────────────────────────────────────────
  // Entirely separate from the JWT path: no end-user token ever reaches these.
  const internal = new Hono();
  internal.use("*", async (c, next) => {
    const t = bearer(c.req.header("authorization"));
    if (!t || t !== cfg.serviceToken) {
      return c.json(err("unauthorized", "service token required", 401), 401);
    }
    await next();
  });
  // FC has no end-user JWT when it assembles workspace-config, so the tier
  // catalogue is served here too (design §6.4).
  internal.get("/models", (c) =>
    c.json({
      object: "list",
      data: Object.entries(catalog.public_models).map(([id, m]) => ({
        id,
        name: m.name,
        pricing: {
          inputPer1mCredits: m.pricing.input_per_1m_credits,
          outputPer1mCredits: m.pricing.output_per_1m_credits,
        },
      })),
    }),
  );
  internal.get("/teams/:teamId/credits/summary", async (c) => {
    const teamId = c.req.param("teamId");
    return c.json({ teamId, balanceCredits: await getBalance(sql, teamId) });
  });
  app.route("/internal", internal);

  return app;
}
