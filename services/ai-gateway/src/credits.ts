import type { Queryable, Sql } from "./db.js";
import { periodStart, type Period } from "./period.js";

/**
 * Credits enforcement: reserve before the upstream call, settle after it.
 *
 * The naive shape — check the balance, call upstream, subtract — overspends
 * under concurrency: N simultaneous requests all read a healthy balance and
 * each spends it. Agent traffic is concurrent by construction (parallel tool
 * calls), so that is the common case rather than an edge case.
 *
 * A reservation closes the window. The row lock is held for the length of a
 * couple of statements, never across the upstream call, which can run for
 * minutes.
 */

export type ReserveInput = {
  teamId: string;
  actorId: string;
  actorType: string;
  /** Conservative upper bound on what this request can cost. */
  holdCredits: number;
  /** How long the hold survives if the request never settles. */
  ttlMs?: number;
};

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; code: "insufficient_credits" | "quota_exceeded"; message: string };

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Take a hold against the team balance and the member's period quota.
 *
 * `for update` on the single balance row is what serialises concurrent
 * requests. Everything inside the transaction is bounded work; the upstream
 * call happens after it commits.
 */
export async function reserve(sql: Sql, input: ReserveInput): Promise<ReserveResult> {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  return sql.begin(async (tx) => {
    const [balanceRow] = await tx<{ balance_credits: string }[]>`
      select balance_credits from amux.team_credit_balance
       where team_id = ${input.teamId}::uuid
         for update`;
    const balance = balanceRow ? Number(balanceRow.balance_credits) : 0;

    const [heldRow] = await tx<{ held: string }[]>`
      select coalesce(sum(amount_credits), 0)::text as held
        from amux.credit_reservation
       where team_id = ${input.teamId}::uuid and state = 'held'`;
    const held = Number(heldRow?.held ?? 0);

    if (balance - held < input.holdCredits) {
      return {
        ok: false as const,
        code: "insufficient_credits" as const,
        message: "the team's credit balance is exhausted",
      };
    }

    const quota = await resolveQuota(tx, input.teamId, input.actorId, input.actorType);
    if (quota) {
      const [usedRow] = await tx<{ used: string }[]>`
        select coalesce(sum(credits), 0)::text as used
          from amux.ai_usage_logs
         where team_id = ${input.teamId}::uuid
           and actor_id = ${input.actorId}::uuid
           and created_at >= ${quota.since}`;
      const [actorHeldRow] = await tx<{ held: string }[]>`
        select coalesce(sum(amount_credits), 0)::text as held
          from amux.credit_reservation
         where team_id = ${input.teamId}::uuid
           and actor_id = ${input.actorId}::uuid
           and state = 'held'`;
      const projected =
        Number(usedRow?.used ?? 0) + Number(actorHeldRow?.held ?? 0) + input.holdCredits;
      if (projected > quota.limit) {
        return {
          ok: false as const,
          code: "quota_exceeded" as const,
          message: `this member's ${quota.period} limit is used up`,
        };
      }
    }

    const [row] = await tx<{ id: string }[]>`
      insert into amux.credit_reservation
        (team_id, actor_id, amount_credits, expires_at)
      values
        (${input.teamId}::uuid, ${input.actorId}::uuid, ${input.holdCredits},
         now() + ${`${Math.ceil(ttl / 1000)} seconds`}::interval)
      returning id`;
    return { ok: true as const, reservationId: row.id };
  });
}

/**
 * The member's limit for the current period, or `null` when unlimited.
 *
 * An `agent` actor with no explicit row is deliberately unlimited: cron and
 * unattended agents run with nobody watching, so stalling one on a limit
 * nobody is awake to raise turns a spend cap into an outage.
 */
async function resolveQuota(
  tx: Queryable,
  teamId: string,
  actorId: string,
  actorType: string,
): Promise<{ limit: number; period: Period; since: Date } | null> {
  const [settings] = await tx<{ period: Period; default_limit_credits: string | null }[]>`
    select period, default_limit_credits from amux.team_credit_settings
     where team_id = ${teamId}::uuid`;
  const period: Period = settings?.period ?? "month";

  const [row] = await tx<{ limit_credits: string | null }[]>`
    select limit_credits from amux.member_credit_quota
     where team_id = ${teamId}::uuid and actor_id = ${actorId}::uuid`;

  let limit: number | null;
  if (row) {
    limit = row.limit_credits === null ? null : Number(row.limit_credits);
  } else if (actorType === "agent") {
    return null;
  } else {
    limit =
      settings?.default_limit_credits === null || settings?.default_limit_credits === undefined
        ? null
        : Number(settings.default_limit_credits);
  }
  if (limit === null) return null;
  return { limit, period, since: periodStart(period) };
}

export type SettleInput = {
  reservationId: string | null;
  teamId: string;
  actorId: string | null;
  credits: number;
  usageLogId: string;
};

/**
 * Charge the actual cost, release the hold, and record it in the ledger — all
 * in one transaction so the balance and the ledger can never disagree.
 */
export async function settle(sql: Sql, input: SettleInput): Promise<void> {
  await sql.begin(async (tx) => {
    if (input.credits > 0) {
      await tx`
        insert into amux.team_credit_balance (team_id, balance_credits)
        values (${input.teamId}::uuid, ${-input.credits})
        on conflict (team_id) do update
          set balance_credits = amux.team_credit_balance.balance_credits - ${input.credits},
              updated_at = now()`;
      await tx`
        insert into amux.credit_ledger
          (team_id, actor_id, kind, amount_credits, usage_log_id)
        values
          (${input.teamId}::uuid, ${input.actorId}::uuid, 'usage',
           ${-input.credits}, ${input.usageLogId}::uuid)`;
    }
    if (input.reservationId) {
      await tx`
        update amux.credit_reservation set state = 'settled'
         where id = ${input.reservationId}::uuid and state = 'held'`;
    }
  });
}

/** Drop a hold whose request never produced a charge (upstream error, cancel). */
export async function release(sql: Sql, reservationId: string | null): Promise<void> {
  if (!reservationId) return;
  await sql`
    update amux.credit_reservation set state = 'expired'
     where id = ${reservationId}::uuid and state = 'held'`;
}

/**
 * Release holds whose requests never came back — a crashed process or a client
 * that vanished mid-stream would otherwise keep that credit reserved forever.
 * Ten minutes is a hard ceiling: a longer request has its hold released early,
 * which is the cheaper of the two failure modes.
 */
export async function sweepExpired(sql: Sql): Promise<number> {
  const rows = await sql`
    update amux.credit_reservation set state = 'expired'
     where state = 'held' and expires_at < now()
    returning id`;
  return rows.length;
}

// ── operator surface ────────────────────────────────────────────────────────
// Everything below goes through the gateway rather than raw SQL because the
// gateway is the ledger's only writer (design §4.9.1). Two writers with
// different idempotency rules is how a money table drifts.

/** Credits granted to a team on first provisioning. See design §4.8. */
export const SIGNUP_GRANT_CREDITS = 10_000_000;

export type TopUpInput = {
  teamId: string;
  amountCredits: number;
  kind: "top_up" | "grant" | "adjustment" | "refund";
  idempotencyKey: string;
  note?: string | null;
};

export type TopUpResult = { applied: boolean; balanceCredits: number };

/**
 * Add credits to a team, exactly once per `idempotencyKey`.
 *
 * Idempotency is enforced by a unique index rather than a read-then-write, so
 * two concurrent deliveries of the same payment cannot both pass the check.
 * `applied: false` means this key was already recorded — the caller retried, or
 * a payment provider delivered the same purchase twice.
 */
export async function topUp(sql: Sql, input: TopUpInput): Promise<TopUpResult> {
  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      insert into amux.credit_ledger
        (team_id, kind, amount_credits, idempotency_key, note)
      values
        (${input.teamId}::uuid, ${input.kind}, ${input.amountCredits},
         ${input.idempotencyKey}, ${input.note ?? null})
      on conflict (team_id, idempotency_key) where idempotency_key is not null
        do nothing
      returning id`;

    if (inserted.length === 0) {
      const [row] = await tx<{ balance_credits: string }[]>`
        select balance_credits from amux.team_credit_balance
         where team_id = ${input.teamId}::uuid`;
      return { applied: false, balanceCredits: Number(row?.balance_credits ?? 0) };
    }

    const [row] = await tx<{ balance_credits: string }[]>`
      insert into amux.team_credit_balance (team_id, balance_credits)
      values (${input.teamId}::uuid, ${input.amountCredits})
      on conflict (team_id) do update
        set balance_credits = amux.team_credit_balance.balance_credits + ${input.amountCredits},
            updated_at = now()
      returning balance_credits`;
    return { applied: true, balanceCredits: Number(row.balance_credits) };
  });
}

export type BackfillResult = { scanned: number; granted: number };

/**
 * Give every team that has never been credited its signup grant.
 *
 * This is the gate on turning enforcement on. Phase 0/1 meter without
 * charging, so every pre-existing team sits at a zero balance; flipping
 * `CREDITS_ENFORCED` before this runs 402s all of them at once (§4.8.1).
 *
 * Safe to re-run: the per-team idempotency key means a second pass grants
 * nothing. Safe to run while serving, too — each team is its own transaction,
 * so a large backfill never holds a long lock.
 */
export async function backfillSignupGrants(
  sql: Sql,
  amountCredits: number = SIGNUP_GRANT_CREDITS,
): Promise<BackfillResult> {
  // Through a security-definer function: amux.teams carries RLS, and a plain
  // select returns zero rows for the gateway's role -- a backfill that grants
  // nothing and exits 0, right before enforcement is switched on.
  const teams = await sql<{ team_id: string }[]>`
    select team_id from amux.ai_gateway_teams_missing_signup_grant()`;
  let granted = 0;
  for (const t of teams) {
    const r = await topUp(sql, {
      teamId: t.team_id,
      amountCredits,
      kind: "grant",
      idempotencyKey: `signup_grant:${t.team_id}`,
      note: "signup grant (backfill)",
    });
    if (r.applied) granted += 1;
  }
  return { scanned: teams.length, granted };
}

export type ReconcileRow = {
  teamId: string;
  balanceCredits: number;
  ledgerCredits: number;
  reason: "drift" | "negative";
};

/**
 * Daily audit. Materialising the balance is what makes `select ... for update`
 * possible; this is the price of that choice.
 *
 * Two findings, both actionable:
 *   drift    — balance and ledger disagree, so one of them is wrong
 *   negative — a balance below zero, which only a refund should ever produce
 *              (§4.9.5). The non-negative CHECK was deliberately omitted so
 *              refunds work, and this is what replaces it.
 */
export async function reconcile(sql: Sql): Promise<ReconcileRow[]> {
  const rows = await sql<
    { team_id: string; balance: string; ledger: string }[]
  >`
    select b.team_id,
           b.balance_credits::text as balance,
           coalesce((select sum(amount_credits) from amux.credit_ledger l
                      where l.team_id = b.team_id), 0)::text as ledger
      from amux.team_credit_balance b`;
  const out: ReconcileRow[] = [];
  for (const r of rows) {
    const balance = Number(r.balance);
    const ledger = Number(r.ledger);
    if (balance !== ledger) {
      out.push({ teamId: r.team_id, balanceCredits: balance, ledgerCredits: ledger, reason: "drift" });
    } else if (balance < 0) {
      out.push({ teamId: r.team_id, balanceCredits: balance, ledgerCredits: ledger, reason: "negative" });
    }
  }
  return out;
}

/**
 * Usage rows older than the retention window. 13 months keeps a full
 * year-over-year comparison available and nothing more.
 *
 * Deleted in bounded batches: one unbounded DELETE over a table that only ever
 * grows is how a retention job turns into an outage.
 */
export async function pruneUsage(sql: Sql, months = 13, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await sql`
      delete from amux.ai_usage_logs
       where id in (
         select id from amux.ai_usage_logs
          where created_at < now() - ${`${months} months`}::interval
          limit ${batch}
       )
      returning id`;
    total += rows.length;
    if (rows.length < batch) return total;
  }
}
