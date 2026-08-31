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
