import type Stripe from "stripe";
import { aiGateway } from "../ai-gateway.js";
import { creditsForPrice, idempotency, stripeClient, stripeConfigured } from "../stripe.js";
import { ApiError } from "../http-utils.js";

/**
 * Stripe → FC inbound webhook (design §4.9).
 *
 * Kept out of team-credits.ts on purpose: everything there is a bearer-
 * authenticated team endpoint, while this one is unauthenticated to the router
 * and authenticated by an HMAC over the raw bytes. Two different trust models
 * in one file is how a route ends up on the wrong one.
 *
 * It touches no repository. The gateway is the ledger's only writer, so all
 * this handler needs is the service token the ai-gateway client already holds
 * — which is why the single-writer rule pays off here: the alternative was a
 * privileged repository handed to an unauthenticated route.
 */
export function registerStripe(router) {
  // MUST be postRaw. Stripe signs the exact bytes it sent; any path that parses
  // the JSON and re-serializes it produces a different payload and fails
  // verification. `ctx.json` is deliberately undefined in raw mode.
  router.postRaw("/v1/stripe/webhook", { auth: "none" }, async (ctx) => {
    if (!stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET?.trim()) {
      throw new ApiError(503, "stripe_unavailable", "Stripe webhook is not configured");
    }
    const stripe = stripeClient();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        ctx.rawBody,
        ctx.getHeader("stripe-signature") ?? "",
        process.env.STRIPE_WEBHOOK_SECRET!.trim(),
      );
    } catch (err) {
      // 400 tells Stripe to retry. Signature failures are not retryable, but
      // answering 200 to an unverifiable body would silently accept a forgery
      // once the secret is ever rotated wrong, and the retries are harmless.
      throw new ApiError(400, "stripe_signature_invalid", (err as Error).message);
    }

    const result = await handleStripeEvent(stripe, event);
    // Always 200 once verified: an error status makes Stripe redeliver for up
    // to 3 days, and a permanent failure (unknown team, missing metadata)
    // would redeliver forever. What must not be lost is recorded by throwing
    // BEFORE this point or by the reconciliation task (§4.9.6).
    return { body: { received: true, ...result } };
  });

  /**
   * Where Stripe sends the browser after checkout.
   *
   * A static page, on purpose. The desktop opened this in the SYSTEM browser
   * (§4.9.7 — the embedded webview breaks 3DS and wallets, and hides the
   * address bar on a payment page), so there is no reliable way back into the
   * app from here, and none is needed: the app never waits on this redirect,
   * it shows "processing" and lets the balance refresh on its own.
   */
  router.get("/v1/stripe/return", { auth: "none" }, async (ctx) => {
    const ok = ctx.query.get("status") !== "cancel";
    const title = ok ? "支付完成 · Payment complete" : "已取消 · Payment cancelled";
    const body = ok
      ? "额度到账后会自动出现在设置 → 账单里，通常几秒内。可以关闭此页面。<br>Credits appear under Settings → Billing, usually within seconds. You can close this page."
      : "没有产生任何扣款。可以关闭此页面。<br>Nothing was charged. You can close this page.";
    return {
      binary: {
        mime: "text/html; charset=utf-8",
        bytes: Buffer.from(
          `<!doctype html><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>${title}</title>` +
            `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
            `font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;` +
            `background:#faf9f7;color:#1c1b19}main{max-width:34rem;padding:2.5rem;text-align:center}` +
            `h1{font-size:1.15rem;margin:0 0 .75rem}p{margin:0;color:#57534e}</style>` +
            `<main><h1>${title}</h1><p>${body}</p></main>`,
          "utf8",
        ),
      },
    };
  });
}

/**
 * The event → ledger mapping. Exported for tests and for the reconciliation
 * task, which replays paid Sessions through the same top-up call.
 */
export async function handleStripeEvent(
  stripe: Stripe,
  event: Stripe.Event,
): Promise<{ handled: boolean; applied?: boolean; reason?: string }> {
  switch (event.type) {
    // Both events can fire for ONE Session (card now, async payment methods
    // later). Keying on the Session id rather than the event id is what stops
    // the second one from crediting the team twice — see §4.9.4.
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") {
        return { handled: false, reason: `payment_status=${session.payment_status}` };
      }
      return creditCheckoutSession(stripe, session);
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      return refundCharge(stripe, charge);
    }

    default:
      return { handled: false, reason: `unhandled event type ${event.type}` };
  }
}

/**
 * Credit one paid Checkout Session. Safe to call repeatedly: the ledger's
 * (team_id, idempotency_key) unique index makes the second call a no-op, which
 * is what lets both the webhook and the reconciliation task run the same path.
 */
export async function creditCheckoutSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<{ handled: true; applied: boolean }> {
  const teamId = teamIdFromSession(session);
  if (!teamId) {
    // Loud, not silent. The Session is created server-side from an
    // authenticated caller's team, so a Session without one means either
    // someone else created it on this account or our own code regressed.
    throw new ApiError(
      500,
      "stripe_session_unattributed",
      `Stripe session ${session.id} carries no team id`,
    );
  }

  const credits = await creditsForSession(stripe, session);
  const res = await aiGateway.topUp(teamId, {
    amountCredits: credits,
    kind: "top_up",
    idempotencyKey: idempotency.checkout(session.id),
    note: `stripe ${session.id}`,
  });
  return { handled: true, applied: Boolean(res?.applied) };
}

/**
 * Debit a team for the refunds on a charge.
 *
 * The refunds are FETCHED, not read off the event. `charge.refunds` is absent
 * from the charge object on current API versions, so `charge.refunds?.data ??
 * []` — which is what this did first — silently yielded an empty list: the loop
 * never ran, the handler answered 200, Stripe stopped retrying, and the
 * customer got their money back while keeping the credits. A refund path that
 * fails by doing nothing at all is the worst shape this could take, so it now
 * asks the API rather than trusting the payload's shape.
 */
async function refundCharge(
  stripe: Stripe,
  charge: Stripe.Charge,
): Promise<{ handled: boolean; applied?: boolean; reason?: string }> {
  const teamId = (charge.metadata?.team_id ?? "").trim();
  if (!teamId) {
    // Loud: the charge came from a Session we created, so it should carry one.
    throw new ApiError(
      500,
      "stripe_refund_unattributed",
      `Stripe charge ${charge.id} carries no team id — refund cannot be applied`,
    );
  }

  const chargedCredits = Number(charge.metadata?.credits ?? 0);
  if (!Number.isSafeInteger(chargedCredits) || chargedCredits <= 0) {
    throw new ApiError(
      500,
      "stripe_refund_unpriced",
      `Stripe charge ${charge.id} carries no usable metadata.credits`,
    );
  }

  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  let applied = false;
  let debited = 0;
  for (const refund of refunds.data) {
    if (refund.status !== "succeeded") continue;
    // Pro-rata, so a PARTIAL refund debits a proportional share rather than the
    // whole purchase. Rounding up is deliberate: the rounding error should not
    // be a way to keep credits that were paid for and then refunded.
    const credits = Math.ceil((chargedCredits * refund.amount) / charge.amount);
    if (credits <= 0) continue;
    const res = await aiGateway.topUp(teamId, {
      // Negative: the ledger is the truth and a refund is allowed to drive the
      // balance below zero (§4.9.5). The spend gate is `balance - reserved >=
      // hold`, which already refuses at a negative balance.
      amountCredits: -credits,
      kind: "refund",
      idempotencyKey: idempotency.refund(refund.id),
      note: `stripe refund ${refund.id}`,
    });
    if (res?.applied) {
      applied = true;
      debited += credits;
    }
  }
  if (refunds.data.length === 0) {
    return { handled: false, reason: `charge ${charge.id} has no refunds to apply` };
  }
  return { handled: true, applied, reason: applied ? `debited ${debited}` : "already recorded" };
}

/** `client_reference_id` is what we set at creation; metadata is the fallback
 *  for Sessions created any other way. */
export function teamIdFromSession(session: Stripe.Checkout.Session): string | null {
  const fromRef = (session.client_reference_id ?? "").trim();
  if (fromRef) return fromRef;
  const fromMeta = (session.metadata?.team_id ?? "").trim();
  return fromMeta || null;
}

/**
 * How many credits this Session bought.
 *
 * Read from the Session's own metadata first — stamped at creation, so the
 * amount is anchored to the moment of purchase and a later price change cannot
 * retroactively alter an in-flight order (§4.9.3). Falling back to the live
 * Price covers Sessions created outside our endpoint.
 */
export async function creditsForSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<number> {
  const stamped = Number(session.metadata?.credits);
  if (Number.isSafeInteger(stamped) && stamped > 0) return stamped;

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ["data.price"],
  });
  let total = 0;
  for (const item of lineItems.data) {
    const price = item.price as Stripe.Price | null;
    if (!price) continue;
    total += creditsForPrice(price) * (item.quantity ?? 1);
  }
  if (total <= 0) {
    throw new ApiError(
      500,
      "stripe_price_misconfigured",
      `Stripe session ${session.id} resolved to 0 credits`,
    );
  }
  return total;
}
