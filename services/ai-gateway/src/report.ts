import type { Sql } from "./db.js";
import { periodStart, type Period } from "./period.js";

/**
 * Usage reporting. Shares `periodStart` with the quota check on purpose: if the
 * two disagreed on where a period begins, a member would read "900 of 1000
 * used" on the billing screen while the gateway refused their next request.
 */
export type UsageRange = "day" | "week" | "month" | "year";

export type UsageSummary = {
  credits: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
};

export type UsageReport = {
  range: UsageRange;
  startUtc: string;
  endUtc: string;
  summary: UsageSummary;
  byModel: Array<{ publicModelId: string } & UsageSummary>;
  byActor: Array<{ actorId: string | null; displayName: string | null } & UsageSummary>;
};

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** [start, end) for a range, anchored to CST like every other period here. */
export function rangeWindow(range: UsageRange, anchor: Date = new Date()): { start: Date; end: Date } {
  if (range === "week" || range === "month") {
    const start = periodStart(range as Period, anchor);
    const cst = new Date(start.getTime() + CST_OFFSET_MS);
    const end =
      range === "week"
        ? new Date(Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate() + 7) - CST_OFFSET_MS)
        : new Date(Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth() + 1, 1) - CST_OFFSET_MS);
    return { start, end };
  }
  const cst = new Date(anchor.getTime() + CST_OFFSET_MS);
  const y = cst.getUTCFullYear();
  if (range === "year") {
    return {
      start: new Date(Date.UTC(y, 0, 1) - CST_OFFSET_MS),
      end: new Date(Date.UTC(y + 1, 0, 1) - CST_OFFSET_MS),
    };
  }
  const m = cst.getUTCMonth();
  const d = cst.getUTCDate();
  return {
    start: new Date(Date.UTC(y, m, d) - CST_OFFSET_MS),
    end: new Date(Date.UTC(y, m, d + 1) - CST_OFFSET_MS),
  };
}

const n = (v: unknown) => Number(v ?? 0);
const summarize = (r: any): UsageSummary => ({
  credits: n(r.credits),
  inputTokens: n(r.input_tokens),
  cachedInputTokens: n(r.cached_input_tokens),
  outputTokens: n(r.output_tokens),
  requests: n(r.requests),
});

export async function usageReport(
  sql: Sql,
  teamId: string,
  range: UsageRange,
  anchor?: Date,
): Promise<UsageReport> {
  const { start, end } = rangeWindow(range, anchor);

  const [total] = await sql<any[]>`
    select coalesce(sum(credits),0)::text as credits,
           coalesce(sum(input_tokens),0)::text as input_tokens,
           coalesce(sum(cached_input_tokens),0)::text as cached_input_tokens,
           coalesce(sum(output_tokens),0)::text as output_tokens,
           count(*)::text as requests
      from amux.ai_usage_logs
     where team_id = ${teamId}::uuid and created_at >= ${start} and created_at < ${end}`;

  // Grouped by the PUBLIC tier, never the backend: the backend a request landed
  // on is a cost detail, and surfacing it would leak the upstream catalogue
  // that §4.3 keeps private.
  const byModel = await sql<any[]>`
    select public_model_id,
           coalesce(sum(credits),0)::text as credits,
           coalesce(sum(input_tokens),0)::text as input_tokens,
           coalesce(sum(cached_input_tokens),0)::text as cached_input_tokens,
           coalesce(sum(output_tokens),0)::text as output_tokens,
           count(*)::text as requests
      from amux.ai_usage_logs
     where team_id = ${teamId}::uuid and created_at >= ${start} and created_at < ${end}
     group by public_model_id
     order by sum(credits) desc`;

  // Attribute usage to humans on the leaderboard: agent spend rolls up to
  // agents.owner_member_id via ai_gateway_usage_bill_to (security definer —
  // the ai_gateway role cannot read actors/agents under RLS). Members stay
  // themselves. Null actor_id sorts last (UI leaves that bucket unranked).
  const byActor = await sql<any[]>`
    select b.bill_to_actor_id as actor_id,
           max(b.display_name) as display_name,
           coalesce(sum(l.credits),0)::text as credits,
           coalesce(sum(l.input_tokens),0)::text as input_tokens,
           coalesce(sum(l.cached_input_tokens),0)::text as cached_input_tokens,
           coalesce(sum(l.output_tokens),0)::text as output_tokens,
           count(*)::text as requests
      from amux.ai_usage_logs l
      left join amux.ai_gateway_usage_bill_to(${teamId}::uuid) b
        on b.usage_actor_id = l.actor_id
     where l.team_id = ${teamId}::uuid and l.created_at >= ${start} and l.created_at < ${end}
     group by b.bill_to_actor_id
     order by (b.bill_to_actor_id is null) asc, sum(l.credits) desc`;

  return {
    range,
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    summary: summarize(total),
    byModel: byModel.map((r) => ({ publicModelId: r.public_model_id, ...summarize(r) })),
    byActor: byActor.map((r) => ({
      actorId: r.actor_id,
      displayName: r.display_name ?? null,
      ...summarize(r),
    })),
  };
}

/** Top-up history. Excludes `usage` — that is one row per request. */
/**
 * Balance and this period's spend for EVERY team that has either, in one query.
 *
 * For an operator screen that ranks teams by what is left, which cannot be
 * built from the per-team endpoints without one request per team. Capped rather
 * than paged: at the size this answers for (hundreds of teams) the whole map is
 * a few kilobytes, and a caller that sorts by balance needs all of it anyway.
 * `truncated` says when the cap cut the list, so a deployment that outgrows it
 * finds out from the data instead of from a silently short screen.
 *
 * A team appears here once it has a balance row or has spent something; one
 * that has neither is simply absent, and the caller treats it as zero.
 */
export async function teamCreditTotals(
  sql: Sql,
  opts: { limit?: number; anchor?: Date } = {},
): Promise<{ items: Array<{ teamId: string; balanceCredits: number; periodCredits: number }>; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 5000);
  const { start, end } = rangeWindow("month", opts.anchor);
  const rows = await sql<any[]>`
    with period as (
      select team_id, coalesce(sum(credits), 0)::text as credits
        from amux.ai_usage_logs
       where created_at >= ${start} and created_at < ${end}
       group by team_id
    )
    select coalesce(b.team_id, p.team_id) as team_id,
           coalesce(b.balance_credits, 0)::text as balance_credits,
           coalesce(p.credits, '0') as period_credits
      from amux.team_credit_balance b
      full join period p on p.team_id = b.team_id
     order by coalesce(b.balance_credits, 0) asc
     limit ${limit + 1}`;
  return {
    items: rows.slice(0, limit).map((r) => ({
      teamId: r.team_id,
      balanceCredits: Number(r.balance_credits),
      periodCredits: Number(r.period_credits),
    })),
    truncated: rows.length > limit,
  };
}

export async function creditLedger(sql: Sql, teamId: string, limit = 50) {
  const rows = await sql<any[]>`
    select id, kind, amount_credits::text as amount_credits, note, created_at
      from amux.credit_ledger
     where team_id = ${teamId}::uuid and kind <> 'usage'
     order by created_at desc
     limit ${Math.min(Math.max(limit, 1), 200)}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountCredits: Number(r.amount_credits),
    note: r.note,
    createdAt: r.created_at,
  }));
}
