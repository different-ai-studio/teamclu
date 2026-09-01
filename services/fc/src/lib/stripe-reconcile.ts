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
import { creditCheckoutSession, refundCharge } from "./routes/stripe.js";
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


// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
// The purchase side had two layers of insurance (Stripe's own retries, plus the
// sweep above) and the refund side had one. That asymmetry is the wrong way
// round: an unrepaired top-up means a paying customer is missing credits and
// will say so within minutes. An unrepaired REFUND is silent — the customer has
// their money back and nobody is watching the balance they kept.
//
// Same shape as the checkout pass, and deliberately the same code path:
// `refundCharge` is what the webhook runs, so this cannot drift from it.

export interface RefundReconcileResult extends Record<string, number> {
  scanned: number;
  succeededRefunds: number;
  /** Charges whose refunds were genuinely missing locally and are now debited. */
  repaired: number;
  alreadyRecorded: number;
  /** Refunds on charges that carry no team id — not ours, and not a problem. */
  notOurs: number;
  failed: number;
}

export async function stripeReconcileRefunds(
  opts: { lookbackDays?: number; stripe?: Stripe } = {},
): Promise<RefundReconcileResult> {
  const result: RefundReconcileResult = {
    scanned: 0,
    succeededRefunds: 0,
    repaired: 0,
    alreadyRecorded: 0,
    notOurs: 0,
    failed: 0,
  };
  if (!opts.stripe && !stripeConfigured()) return result;

  const stripe = opts.stripe ?? stripeClient();
  const days = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = Math.floor(Date.now() / 1000) - days * 86_400;

  // Grouped by charge, because `refundCharge` works per charge and applies
  // every refund on it. A charge refunded in three parts is one unit of work,
  // and each part still lands under its own idempotency key.
  const charges = new Set<string>();
  for await (const refund of stripe.refunds.list({ created: { gte: since }, limit: 100 })) {
    result.scanned += 1;
    if (refund.status !== "succeeded") continue;
    result.succeededRefunds += 1;
    const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
    if (chargeId) charges.add(chargeId);
  }

  for (const chargeId of charges) {
    try {
      const charge = await stripe.charges.retrieve(chargeId);
      // Unlike the webhook — which receives an event for a charge that SHOULD be
      // ours and so shouts about a missing team id — this pass walks every
      // refund on the account. A charge with no team id is simply someone
      // else's, and treating that as a failure would bury the real ones.
      if (!(charge.metadata?.team_id ?? "").trim()) {
        result.notOurs += 1;
        continue;
      }
      const r = await refundCharge(stripe, charge);
      if (r.applied) {
        result.repaired += 1;
        console.warn(
          `[stripe/reconcile] debited refunds on charge ${chargeId} that the webhook never delivered`,
        );
      } else {
        result.alreadyRecorded += 1;
      }
    } catch (err) {
      // One bad charge must not stop the rest — this IS the recovery path.
      result.failed += 1;
      console.error(`[stripe/reconcile] charge ${chargeId} failed:`, err);
    }
  }
  return result;
}

/** Both passes. What the cron task runs. */
export async function stripeReconcile(
  opts: { lookbackDays?: number; stripe?: Stripe } = {},
): Promise<Record<string, number>> {
  const checkouts = await stripeReconcileCheckouts(opts);
  const refunds = await stripeReconcileRefunds(opts);
  return {
    ...checkouts,
    refundsScanned: refunds.scanned,
    refundsRepaired: refunds.repaired,
    refundsAlreadyRecorded: refunds.alreadyRecorded,
    refundsNotOurs: refunds.notOurs,
    refundsFailed: refunds.failed,
  };
}
