import { aiGateway } from "../ai-gateway.js";

/**
 * Team credits: balance, usage, top-up history, member limits.
 *
 * Permission split follows design §12.6 — balance and usage are visible to
 * every member (an exhausted wallet stops their work, so they need to be able
 * to see why), while the ledger and any mutation are owner-only.
 *
 * The repository does the authz; this file only shapes requests. Both backend
 * paths reach the same gateway, so the credits data is identical either way.
 */
export function registerTeamCredits(router) {
  // Balance + the current period at a glance. What the billing screen opens on.
  router.get("/v1/teams/:teamId/credits", async (ctx) => {
    return { body: await ctx.repository.getTeamCredits(ctx.params.teamId) };
  });

  // range = day|week|month|year (default month); `date` picks a past period.
  router.get("/v1/teams/:teamId/credits/usage", async (ctx) => {
    return {
      body: await ctx.repository.getCreditUsage(ctx.params.teamId, {
        range: ctx.query.get("range") ?? "month",
        date: ctx.query.get("date") ?? undefined,
      }),
    };
  });

  // Top-ups, grants, adjustments and refunds — NOT per-request usage, which is
  // one row per call and belongs in the usage report. Owner-only: it carries
  // money amounts.
  router.get("/v1/teams/:teamId/credits/ledger", async (ctx) => {
    return {
      body: await ctx.repository.getCreditLedger(ctx.params.teamId, {
        limit: Number(ctx.query.get("limit") ?? 50),
      }),
    };
  });

  router.post("/v1/teams/:teamId/credits/top-up", async (ctx) => {
    return { body: await ctx.repository.topUpCredits(ctx.params.teamId, ctx.json ?? {}) };
  });

  // What a team can buy. Shape and price come from Stripe (the allowlisted
  // Prices and their metadata.credits) so nothing about pricing is duplicated
  // in this repo — see design §4.9.3.
  router.get("/v1/teams/:teamId/credits/packages", async (ctx) => {
    return { body: await ctx.repository.listCreditPackages(ctx.params.teamId) };
  });

  // Opens a Stripe Checkout Session for one package. Owner-only: it is the
  // action that spends the team's money.
  router.post("/v1/teams/:teamId/credits/checkout-session", async (ctx) => {
    return {
      body: await ctx.repository.createCreditCheckoutSession(ctx.params.teamId, ctx.json ?? {}),
    };
  });

  router.get("/v1/teams/:teamId/quotas", async (ctx) => {
    return { body: await ctx.repository.getMemberQuotas(ctx.params.teamId) };
  });

  router.put("/v1/teams/:teamId/quotas", async (ctx) => {
    return { body: await ctx.repository.setMemberQuotas(ctx.params.teamId, ctx.json ?? {}) };
  });
}
