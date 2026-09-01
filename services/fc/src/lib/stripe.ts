// ---------------------------------------------------------------------------
// Stripe client + the credit-package allowlist (design §4.9).
//
// Stripe lives in FC, not in the gateway: the gateway is the credit ledger's
// only writer and deliberately carries nothing but upstream provider keys, and
// payments are business-面 (products, tax, invoices, refunds, customers). The
// webhook handler therefore needs no database access at all — it verifies a
// signature and calls the gateway's /internal top-up.
// ---------------------------------------------------------------------------
import Stripe from "stripe";
import { ApiError } from "./http-utils.js";

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** Fail closed: a missing key must be a 503, never a call to a default account. */
export function stripeClient(): Stripe {
  if (!stripeConfigured()) {
    throw new ApiError(503, "stripe_unavailable", "Stripe is not configured (STRIPE_SECRET_KEY)");
  }
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY!.trim(), {
      // Pinned rather than "latest": an account-level API upgrade in the Stripe
      // dashboard must not silently reshape webhook payloads under a running
      // deployment.
      apiVersion: "2026-08-26.dahlia",
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return client;
}

/**
 * The Price ids a client is allowed to buy, from `STRIPE_PRICE_IDS`
 * (comma-separated).
 *
 * An allowlist rather than "any active Price": the checkout endpoint takes a
 * price id from the caller, and without this, anyone who can read the team's id
 * could open a Session against an arbitrary Price on our account — including a
 * 1-cent one carrying a large `metadata.credits`.
 */
export function allowedPriceIds(): string[] {
  return (process.env.STRIPE_PRICE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Credits carried by a Price, from `metadata.credits` (§4.9.3).
 *
 * Deliberately fail-closed: a Price without the metadata is REJECTED, never
 * guessed from the amount. The alternative — inferring credits from currency
 * and unit_amount — bakes an exchange rate and a markup into code, in the one
 * place where being wrong means either giving away service or shorting a paying
 * customer.
 */
export function creditsForPrice(price: Stripe.Price): number {
  const raw = price.metadata?.credits;
  const n = Number(raw);
  if (!raw || !Number.isSafeInteger(n) || n <= 0) {
    throw new ApiError(
      500,
      "stripe_price_misconfigured",
      `Stripe price ${price.id} has no usable metadata.credits (got ${JSON.stringify(raw ?? null)})`,
    );
  }
  return n;
}

/** Idempotency keys — one per money-moving Stripe object (§4.9.4). */
export const idempotency = {
  /** Checkout Session, NOT event: one Session emits several events with
   *  different evt_ ids, and keying on those double-credits the team. */
  checkout: (sessionId: string) => `stripe:cs:${sessionId}`,
  refund: (refundId: string) => `stripe:re:${refundId}`,
};

/** One buyable credit package: an allowlisted Price plus what it grants. */
export interface CreditPackage {
  priceId: string;
  /** Credits granted on purchase, from `metadata.credits`. */
  credits: number;
  /** Minor units (cents/分) — Stripe's own unit, passed through unconverted. */
  unitAmount: number | null;
  currency: string;
  name: string;
}

/**
 * Resolve the allowlist into displayable packages.
 *
 * A Price that is missing, archived, or has no `metadata.credits` is DROPPED
 * with a warning rather than failing the whole list: one misconfigured entry
 * must not take the top-up screen down for the others. What it must never do is
 * be sold — and it cannot be, because checkout re-checks the same allowlist and
 * `creditsForPrice` throws on the missing metadata.
 */
export async function listCreditPackages(): Promise<CreditPackage[]> {
  const stripe = stripeClient();
  const ids = allowedPriceIds();
  if (ids.length === 0) return [];

  const out: CreditPackage[] = [];
  for (const id of ids) {
    try {
      const price = await stripe.prices.retrieve(id, { expand: ["product"] });
      if (price.active === false) {
        console.warn(`[stripe] price ${id} is archived — skipping`);
        continue;
      }
      const product = price.product;
      const productName =
        typeof product === "object" && product !== null && "name" in product ? product.name : null;
      out.push({
        priceId: price.id,
        credits: creditsForPrice(price),
        unitAmount: price.unit_amount ?? null,
        currency: price.currency,
        name: productName || price.nickname || price.id,
      });
    } catch (err) {
      console.warn(`[stripe] price ${id} is unusable — skipping:`, (err as Error).message);
    }
  }
  return out;
}

export interface CheckoutSessionInput {
  teamId: string;
  priceId: string;
  /** Who clicked buy — recorded on the Session for support, never trusted for authz. */
  actorId?: string | null;
  /** Injectable so tests can assert the params we send without a live account. */
  stripe?: Stripe;
}

/**
 * Open a Stripe Checkout Session for one credit package.
 *
 * The team id is stamped in BOTH `client_reference_id` and `metadata` and is
 * taken from the already-authorized route, never from the request body: the
 * Session is the only thing the webhook can attribute a payment by, so letting
 * a caller name the team would let anyone top up — or mis-credit — a team they
 * do not belong to.
 *
 * `metadata.credits` is stamped at creation so the granted amount is frozen at
 * purchase time; a later price change cannot retroactively alter an order that
 * is already in flight (§4.9.3).
 */
export async function createCheckoutSession(
  input: CheckoutSessionInput,
): Promise<{ sessionId: string; url: string }> {
  const stripe = input.stripe ?? stripeClient();
  if (!allowedPriceIds().includes(input.priceId)) {
    throw new ApiError(400, "invalid_price", "priceId is not an offered credit package");
  }
  const price = await stripe.prices.retrieve(input.priceId);
  const credits = creditsForPrice(price);
  const base = returnUrlBase();

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      // We are the merchant of record, not Link.
      //
      // Managed Payments is ON by default on this account and changes who
      // sells: the hosted page reads "sold through Link — you authorise Link to
      // charge you", Link owns the tax treatment (a 9% GST line turned an
      // HK$98 order into HK$106.82), and the payment runs on Link's own rails.
      // That last part is not cosmetic — a real Apple Pay attempt failed there
      // and left NO PaymentIntent and no event on our account, so there was
      // nothing to debug from. Turning it off also switches automatic_tax back
      // off, which is correct: being the merchant of record means owning the
      // tax question rather than having one silently answered for us.
      //
      // Cast: the API accepts this (its own error message recommends it) but it
      // is absent from the SDK's typed surface as of v22.6.0.
      ...({ managed_payments: { enabled: false } } as Record<string, unknown>),
      line_items: [{ price: input.priceId, quantity: 1 }],
      client_reference_id: input.teamId,
      metadata: {
        team_id: input.teamId,
        credits: String(credits),
        ...(input.actorId ? { actor_id: input.actorId } : {}),
      },
      // Copied onto the PaymentIntent and from there onto the Charge, which is
      // the only object a `charge.refunded` event carries — without this a
      // refund has no team to debit.
      payment_intent_data: {
        metadata: {
          team_id: input.teamId,
          credits: String(credits),
        },
      },
      success_url: `${base}/v1/stripe/return?status=success`,
      cancel_url: `${base}/v1/stripe/return?status=cancel`,
    },
    // Not idempotent across packages on purpose: buying the same package twice
    // in a row is a legitimate thing to do, and the ledger key is the Session
    // id, so two Sessions are two top-ups by design.
    { idempotencyKey: undefined },
  );

  if (!session.url) {
    throw new ApiError(502, "stripe_error", "Stripe returned a session with no checkout URL");
  }
  return { sessionId: session.id, url: session.url };
}

/**
 * Public origin for the post-checkout landing pages.
 *
 * Its OWN variable, deliberately, after the first version tried to reuse an
 * existing one twice and was wrong both times:
 *
 * - `AUTH_BASE_URL` is the Better-Auth issuer/JWKS origin. On the supabase
 *   backend path nothing calls it, so it sits EMPTY on the deployment that
 *   actually runs — checkout failed with "AUTH_BASE_URL is not set". Filling it
 *   in to please Stripe would also quietly become the JWT issuer the day
 *   BACKEND_KIND flips to postgres.
 * - `API_EXTERNAL_URL` belongs to GoTrue (deploy/self-host/supabase/
 *   docker-compose.yml). It happens to hold the Cloud API host here, which is
 *   itself a surprising local choice; anyone "correcting" it to the Supabase
 *   host would silently repoint these return URLs.
 *
 * The desktop never depends on this redirect — it shows "processing" and lets
 * the balance refresh (§4.9.7) — so the page only has to tell a human they can
 * close the tab. That is not a reason to let its origin be ambiguous.
 */
function returnUrlBase(): string {
  const base = process.env.STRIPE_RETURN_URL_BASE?.trim();
  if (!base) {
    throw new ApiError(
      503,
      "stripe_unavailable",
      "STRIPE_RETURN_URL_BASE is not set — Stripe checkout needs this deployment's public origin for its return URLs",
    );
  }
  return base.replace(/\/+$/, "");
}
