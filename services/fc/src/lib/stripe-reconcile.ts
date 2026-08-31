// ---------------------------------------------------------------------------
// Stripe → credits reconciliation (design §4.9.6).
//
// The webhook is NOT the only path that grants credits, on purpose. Stripe
// calls in from outside the country to a host that resolves to a mainland
// machine, and this repo already has a precedent for that link being blocked
// (the box cannot reach Google; GoTrue needs an offshore proxy). If deliveries
// are dropped, a customer has paid and has nothing.
//
// So this task re-walks recent Checkout Sessions and pushes every paid one
// through the SAME top-up call the webhook uses. That is safe to run on any
// schedule because the ledger's (team_id, idempotency_key) unique index makes a
// repeat a no-op — which also means this needs no ledger query of its own: the
// `applied` flag coming back is the answer to "was this one missing".
// ---------------------------------------------------------------------------
import type Stripe from "stripe";
import { creditCheckoutSession } from "./routes/stripe.js";
import { stripeClient, stripeConfigured } from "./stripe.js";

export interface ReconcileResult extends Record<string, number> {
  scanned: number;
  paid: number;
  /** Sessions that were genuinely missing locally and have now been credited. */
  repaired: number;
  /** Already present — the healthy case, and the expected majority. */
  alreadyCredited: number;
  failed: number;
}

/**
 * Stripe retries a failed delivery for up to 3 days, so anything older than
 * that has exhausted its own recovery. The window is wider than 3 days because
 * this task is the layer that catches the case where retries never arrived at
 * all — a link that was down for the whole retry window is exactly the failure
 * it exists for.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

export async function stripeReconcileCheckouts(
  /** `stripe` is injectable so tests exercise this without a live account —
   *  the first version of this file reached api.stripe.com from `npm test`. */
  opts: { lookbackDays?: number; stripe?: Stripe } = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    scanned: 0,
    paid: 0,
    repaired: 0,
    alreadyCredited: 0,
    failed: 0,
  };
  if (!opts.stripe && !stripeConfigured()) return result;

  const stripe = opts.stripe ?? stripeClient();
  const days = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = Math.floor(Date.now() / 1000) - days * 86_400;

  for await (const session of stripe.checkout.sessions.list({
    created: { gte: since },
    limit: 100,
  })) {
    result.scanned += 1;
    if (session.payment_status !== "paid") continue;
    result.paid += 1;
    try {
      const { applied } = await creditCheckoutSession(stripe, session);
      if (applied) {
        result.repaired += 1;
        // Worth a line in the log: a repair means a webhook delivery was lost,
        // which is the signal that the cross-border link is degrading.
        console.warn(
          `[stripe/reconcile] credited session ${session.id} that the webhook never delivered`,
        );
      } else {
        result.alreadyCredited += 1;
      }
    } catch (err) {
      // One bad session (deleted team, misconfigured price) must not stop the
      // rest — this is the recovery path, and it running to completion matters
      // more than any single row.
      result.failed += 1;
      console.error(`[stripe/reconcile] session ${session.id} failed:`, err);
    }
  }
  return result;
}
