/**
 * Stripe credit top-ups (design §4.9).
 *
 * The three things worth pinning here are the ones that cost real money when
 * wrong: the raw-body signature path, the idempotency key being the SESSION id
 * rather than the event id, and the refusal to guess credits for a Price that
 * has no metadata.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Hono } from "hono";
import { createHonoRouterAdapter } from "../src/lib/hono-adapter.js";
import { aiGateway } from "../src/lib/ai-gateway.js";
import { allowedPriceIds, createCheckoutSession, creditsForPrice, idempotency } from "../src/lib/stripe.js";
import { registerStripe, handleStripeEvent, creditsForSession } from "../src/lib/routes/stripe.js";
import { stripeReconcile, stripeReconcileCheckouts, stripeReconcileRefunds } from "../src/lib/stripe-reconcile.js";

const WEBHOOK_SECRET = "whsec_test_secret";

/** Every top-up the code under test attempted, in order. */
let topUps: Array<{ teamId: string; body: any }> = [];
const realTopUp = aiGateway.topUp;

beforeEach(() => {
  topUps = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_IDS = "price_a, price_b";
  process.env.STRIPE_RETURN_URL_BASE = "https://api.example.com";
  // The gateway is the ledger's only writer, so intercepting this one call is
  // the whole surface between Stripe and the money.
  (aiGateway as any).topUp = async (teamId: string, body: any) => {
    topUps.push({ teamId, body });
    return { teamId, applied: true, balanceCredits: 123 };
  };
});

process.on("exit", () => { (aiGateway as any).topUp = realTopUp; });

function session(over: Record<string, any> = {}) {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    payment_status: "paid",
    client_reference_id: "team-1",
    metadata: { team_id: "team-1", credits: "5000000" },
    ...over,
  } as any;
}

function event(type: string, object: any) {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } } as any;
}

// --- allowlist / pricing ---------------------------------------------------

test("the price allowlist is parsed and trimmed", () => {
  assert.deepEqual(allowedPriceIds(), ["price_a", "price_b"]);
  process.env.STRIPE_PRICE_IDS = "";
  assert.deepEqual(allowedPriceIds(), []);
});

test("a Price without metadata.credits is refused, never guessed from the amount", () => {
  assert.equal(creditsForPrice({ id: "price_a", metadata: { credits: "5000" } } as any), 5000);
  for (const bad of [undefined, "", "0", "-1", "abc", "1.5"]) {
    assert.throws(
      () => creditsForPrice({ id: "price_a", unit_amount: 9900, metadata: { credits: bad } } as any),
      (err: any) => err?.code === "stripe_price_misconfigured",
      `metadata.credits=${JSON.stringify(bad)} must be refused`,
    );
  }
});

// --- idempotency: the double-credit bug ------------------------------------

test("both completion events for ONE session produce ONE ledger key", async () => {
  const s = session();
  await handleStripeEvent({} as any, event("checkout.session.completed", s));
  await handleStripeEvent({} as any, event("checkout.session.async_payment_succeeded", s));

  assert.equal(topUps.length, 2, "both events reach the ledger");
  // ...and the ledger's (team_id, idempotency_key) unique index collapses them,
  // because the key is the Session id. Keying on the event id would not: the
  // two events have different evt_ ids.
  assert.equal(topUps[0].body.idempotencyKey, "stripe:cs:cs_test_1");
  assert.equal(topUps[1].body.idempotencyKey, "stripe:cs:cs_test_1");
  assert.equal(topUps[0].body.amountCredits, 5000000);
  assert.equal(topUps[0].body.kind, "top_up");
});

test("an unpaid session credits nothing", async () => {
  const r = await handleStripeEvent({} as any, event("checkout.session.completed", session({ payment_status: "unpaid" })));
  assert.equal(r.handled, false);
  assert.equal(topUps.length, 0);
});

test("a session with no team is a loud failure, not a silent drop", async () => {
  await assert.rejects(
    () => handleStripeEvent({} as any, event("checkout.session.completed",
      session({ client_reference_id: null, metadata: {} }))),
    (err: any) => err?.code === "stripe_session_unattributed",
  );
  assert.equal(topUps.length, 0);
});

test("an unhandled event type is reported, not thrown", async () => {
  const r = await handleStripeEvent({} as any, event("customer.created", { id: "cus_1" }));
  assert.equal(r.handled, false);
  assert.match(String(r.reason), /customer\.created/);
});

/** A charge as the live API actually returns it: NO `refunds` key. */
function charge(over: Record<string, any> = {}) {
  return {
    id: "ch_1",
    amount: 500,
    metadata: { team_id: "team-1", credits: "1500000" },
    ...over,
  } as any;
}

function stripeWithRefunds(data: any[]) {
  return { refunds: { list: async () => ({ data }) } } as any;
}

test("a refund debits the team and is keyed by refund id", async () => {
  const stripe = stripeWithRefunds([{ id: "re_1", amount: 500, status: "succeeded" }]);
  const r = await handleStripeEvent(stripe, event("charge.refunded", charge()));
  assert.equal(r.handled, true);
  assert.equal(topUps.length, 1);
  assert.equal(topUps[0].body.amountCredits, -1500000, "refunds are negative — the balance may legally go below zero");
  assert.equal(topUps[0].body.kind, "refund");
  assert.equal(topUps[0].body.idempotencyKey, idempotency.refund("re_1"));
});

test("refunds are FETCHED, not read off the event payload", async () => {
  // Regression guard for a silent-loss bug. `charge.refunds` is absent from the
  // charge object on current API versions, so reading `charge.refunds?.data ??
  // []` produced an empty list: the loop never ran, the handler answered 200,
  // Stripe stopped retrying, and the customer kept the credits they had been
  // refunded for. Verified against the live API — a retrieved charge has no
  // `refunds` key at all.
  assert.equal("refunds" in charge(), false, "the fixture must match the live shape");
  const stripe = stripeWithRefunds([{ id: "re_1", amount: 500, status: "succeeded" }]);
  await handleStripeEvent(stripe, event("charge.refunded", charge()));
  assert.equal(topUps.length, 1, "the refund must be applied even though the event carried no refunds list");
});

test("a PARTIAL refund debits a proportional share, rounded against the customer", async () => {
  const stripe = stripeWithRefunds([{ id: "re_partial", amount: 200, status: "succeeded" }]);
  await handleStripeEvent(stripe, event("charge.refunded", charge()));
  // 1,500,000 credits * 200/500 = 600,000 — not the whole purchase.
  assert.equal(topUps[0].body.amountCredits, -600000);
});

test("a pending refund is not debited yet", async () => {
  const stripe = stripeWithRefunds([{ id: "re_pending", amount: 500, status: "pending" }]);
  const r = await handleStripeEvent(stripe, event("charge.refunded", charge()));
  assert.equal(topUps.length, 0);
  assert.equal(r.applied, false);
});

test("a charge with no team id fails loudly rather than dropping the refund", async () => {
  const stripe = stripeWithRefunds([{ id: "re_1", amount: 500, status: "succeeded" }]);
  await assert.rejects(
    () => handleStripeEvent(stripe, event("charge.refunded", charge({ metadata: {} }))),
    (err: any) => err?.code === "stripe_refund_unattributed",
  );
  assert.equal(topUps.length, 0);
});

// --- credits resolution ----------------------------------------------------

test("credits come from the session metadata stamped at purchase time", async () => {
  const stripe = {
    checkout: { sessions: { listLineItems: async () => { throw new Error("must not be called"); } } },
  } as any;
  assert.equal(await creditsForSession(stripe, session()), 5000000);
});

test("a session with no stamped credits falls back to the live Price", async () => {
  const stripe = {
    checkout: {
      sessions: {
        listLineItems: async () => ({
          data: [{ quantity: 2, price: { id: "price_a", metadata: { credits: "1000" } } }],
        }),
      },
    },
  } as any;
  assert.equal(await creditsForSession(stripe, session({ metadata: {} })), 2000);
});

// --- checkout session params ----------------------------------------------

function captureStripe() {
  const seen: any = {};
  return {
    seen,
    client: {
      prices: {
        retrieve: async (id: string) => ({ id, metadata: { credits: "5000" } }),
      },
      checkout: {
        sessions: {
          create: async (params: any) => {
            seen.params = params;
            return { id: "cs_test_new", url: "https://checkout.stripe.com/c/pay/cs_test_new" };
          },
        },
      },
    } as any,
  };
}

test("checkout opts OUT of Managed Payments — we are the merchant of record", async () => {
  // Regression guard for a production failure. With Managed Payments on (the
  // account default), the hosted page sold "through Link", Link owned the tax
  // treatment (a 9% GST line turned an HK$98 order into HK$106.82), and the
  // payment ran on Link's rails — where a failed Apple Pay attempt left NO
  // PaymentIntent and no event on our account, so there was nothing to debug.
  const { seen, client } = captureStripe();
  await createCheckoutSession({ teamId: "team-1", priceId: "price_a", stripe: client });
  assert.deepEqual(seen.params.managed_payments, { enabled: false });
});

test("the team is stamped where a payment can be attributed by, and nowhere else", async () => {
  const { seen, client } = captureStripe();
  await createCheckoutSession({ teamId: "team-1", priceId: "price_b", stripe: client });

  // Both, because the webhook reads client_reference_id first and metadata is
  // the fallback for Sessions created any other way.
  assert.equal(seen.params.client_reference_id, "team-1");
  assert.equal(seen.params.metadata.team_id, "team-1");
  // Frozen at purchase time: a later price change must not alter an in-flight
  // order (§4.9.3).
  assert.equal(seen.params.metadata.credits, "5000");
  // Copied onto the PaymentIntent -> Charge, the only object a charge.refunded
  // event carries. Without it a refund has no team to debit.
  assert.equal(seen.params.payment_intent_data.metadata.team_id, "team-1");
  assert.equal(seen.params.payment_intent_data.metadata.credits, "5000");
  assert.equal(seen.params.success_url, "https://api.example.com/v1/stripe/return?status=success");
});

// --- the webhook route: raw bytes in, signature verified -------------------

function signedRequest(payload: string, secret = WEBHOOK_SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return new Request("http://local/v1/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` },
    body: payload,
  });
}

function webhookApp() {
  const app = new Hono();
  const router = createHonoRouterAdapter(app, {
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
  });
  registerStripe(router);
  return app;
}

test("a correctly signed body is accepted and credited", async () => {
  const payload = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: session() },
  });
  const res = await webhookApp().fetch(signedRequest(payload));
  assert.equal(res.status, 200, await res.text());
  assert.equal(topUps.length, 1);
  assert.equal(topUps[0].teamId, "team-1");
});

test("a body signed with the wrong secret is rejected with 400", async () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: session() } });
  const res = await webhookApp().fetch(signedRequest(payload, "whsec_wrong"));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).error.code, "stripe_signature_invalid");
  assert.equal(topUps.length, 0);
});

test("an unsigned body is rejected", async () => {
  const res = await webhookApp().fetch(new Request("http://local/v1/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "checkout.session.completed" }),
  }));
  assert.equal(res.status, 400);
  assert.equal(topUps.length, 0);
});

test("with Stripe unconfigured the webhook is 503, not a crash", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const res = await webhookApp().fetch(signedRequest("{}"));
  assert.equal(res.status, 503);
});

test("the checkout return page is HTML and needs no auth", async () => {
  const res = await webhookApp().fetch(new Request("http://local/v1/stripe/return?status=success"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const cancelled = await webhookApp().fetch(new Request("http://local/v1/stripe/return?status=cancel"));
  assert.match(await cancelled.text(), /没有产生任何扣款|Nothing was charged/);
});

// --- reconciliation --------------------------------------------------------

function fakeStripeWithSessions(sessions: any[]) {
  return {
    checkout: {
      sessions: {
        list: () => ({ [Symbol.asyncIterator]: async function* () { for (const s of sessions) yield s; } }),
        listLineItems: async () => ({ data: [] }),
      },
    },
  } as any;
}

test("reconcile re-credits only the sessions the webhook never delivered", async () => {
  // The ledger's unique index is what answers "was this one missing": a repeat
  // top-up is a no-op reporting applied:false, so reconcile needs no ledger
  // query of its own.
  const missing = new Set(["stripe:cs:cs_missing"]);
  (aiGateway as any).topUp = async (teamId: string, body: any) => {
    topUps.push({ teamId, body });
    return { teamId, applied: missing.has(body.idempotencyKey), balanceCredits: 1 };
  };

  const result = await stripeReconcileCheckouts({
    stripe: fakeStripeWithSessions([
      session({ id: "cs_present" }),
      session({ id: "cs_missing" }),
      session({ id: "cs_unpaid", payment_status: "unpaid" }),
    ]),
  });

  assert.deepEqual(result, {
    scanned: 3,
    paid: 2,
    repaired: 1,
    alreadyCredited: 1,
    failed: 0,
  });
});

test("one unusable session does not abort the rest of the run", async () => {
  const result = await stripeReconcileCheckouts({
    stripe: fakeStripeWithSessions([
      // No team: throws inside creditCheckoutSession.
      session({ id: "cs_bad", client_reference_id: null, metadata: {} }),
      session({ id: "cs_good" }),
    ]),
  });
  assert.equal(result.failed, 1);
  assert.equal(result.repaired + result.alreadyCredited, 1, "the good session still went through");
});

function fakeStripeWithRefunds(refunds: any[], charges: Record<string, any>) {
  return {
    refunds: {
      list: (opts: any) =>
        // The webhook path calls refunds.list({charge}); the reconcile pass
        // calls it with {created} and iterates. One fake serves both.
        opts?.charge
          ? Promise.resolve({ data: refunds.filter((r) => r.charge === opts.charge) })
          : { [Symbol.asyncIterator]: async function* () { for (const r of refunds) yield r; } },
    },
    charges: { retrieve: async (id: string) => charges[id] },
  } as any;
}

test("reconcile repairs refunds the webhook never delivered", async () => {
  // The purchase side had two layers of insurance and the refund side had one.
  // That is the wrong way round: a missing top-up gets reported by the customer
  // within minutes, a missing refund debit is silent — they have their money
  // back and nobody is watching the credits they kept.
  const missing = new Set(["stripe:re:re_missing"]);
  (aiGateway as any).topUp = async (teamId: string, body: any) => {
    topUps.push({ teamId, body });
    return { teamId, applied: missing.has(body.idempotencyKey), balanceCredits: 1 };
  };

  const stripe = fakeStripeWithRefunds(
    [
      { id: "re_present", charge: "ch_a", amount: 500, status: "succeeded" },
      { id: "re_missing", charge: "ch_b", amount: 500, status: "succeeded" },
      { id: "re_pending", charge: "ch_c", amount: 500, status: "pending" },
      { id: "re_other", charge: "ch_other", amount: 500, status: "succeeded" },
    ],
    {
      ch_a: { id: "ch_a", amount: 500, metadata: { team_id: "team-1", credits: "1500000" } },
      ch_b: { id: "ch_b", amount: 500, metadata: { team_id: "team-1", credits: "1500000" } },
      // Someone else's charge on the same account: no team id.
      ch_other: { id: "ch_other", amount: 500, metadata: {} },
    },
  );

  const r = await stripeReconcileRefunds({ stripe });
  assert.equal(r.scanned, 4);
  assert.equal(r.succeededRefunds, 3, "the pending refund is not counted");
  assert.equal(r.repaired, 1);
  assert.equal(r.alreadyRecorded, 1);
  assert.equal(r.notOurs, 1, "a charge with no team id is someone else's, not a failure");
  assert.equal(r.failed, 0);
});

test("a charge that cannot be retrieved does not abort the refund sweep", async () => {
  const stripe = {
    refunds: {
      list: (opts: any) =>
        opts?.charge
          ? Promise.resolve({ data: [{ id: "re_ok", charge: "ch_ok", amount: 500, status: "succeeded" }] })
          : { [Symbol.asyncIterator]: async function* () {
              yield { id: "re_boom", charge: "ch_boom", amount: 500, status: "succeeded" };
              yield { id: "re_ok", charge: "ch_ok", amount: 500, status: "succeeded" };
            } },
    },
    charges: {
      retrieve: async (id: string) => {
        if (id === "ch_boom") throw new Error("no such charge");
        return { id, amount: 500, metadata: { team_id: "team-1", credits: "1500000" } };
      },
    },
  } as any;
  const r = await stripeReconcileRefunds({ stripe });
  assert.equal(r.failed, 1);
  assert.equal(r.repaired + r.alreadyRecorded, 1, "the good charge still went through");
});

test("the cron task runs BOTH passes", async () => {
  const stripe = {
    checkout: { sessions: { list: () => ({ [Symbol.asyncIterator]: async function* () {} }) } },
    refunds: { list: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    charges: { retrieve: async () => ({}) },
  } as any;
  const r = await stripeReconcile({ stripe });
  // Checkout counters and refund counters both present — a task that silently
  // dropped one half would still "succeed" without this.
  for (const k of ["scanned", "paid", "repaired", "refundsScanned", "refundsRepaired", "refundsFailed"]) {
    assert.ok(k in r, `${k} missing from the combined result`);
  }
});

test("reconcile is a no-op when Stripe is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const result = await stripeReconcileCheckouts();
  assert.equal(result.scanned, 0);
  assert.equal(topUps.length, 0);
});
