import postgres from "postgres";

export type Sql = postgres.Sql<{}>;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, prepare: false });
}

export type Actor = { id: string; actorType: string };

/**
 * Resolve the caller's actor within this team.
 *
 * One call does two jobs: it produces the billing subject AND proves
 * membership. The `:teamId` in the path is caller-supplied and untrusted — a
 * token only says who you are, never which team you may spend from. The unique
 * index `actors_team_user_idx (team_id, user_id) where user_id is not null`
 * makes a single lookup sufficient.
 *
 * Goes through a security-definer function rather than selecting from
 * amux.actors directly: that table has RLS, the gateway is not service_role,
 * and it never sets a request JWT on its connection — so a plain select returns
 * zero rows and every legitimate member would get 403.
 */
export async function resolveActor(sql: Sql, teamId: string, userId: string): Promise<Actor | null> {
  const rows = await sql<{ id: string; actor_type: string }[]>`
    select id, actor_type from amux.ai_gateway_resolve_actor(${teamId}::uuid, ${userId}::uuid)`;
  const r = rows[0];
  return r ? { id: r.id, actorType: r.actor_type } : null;
}

export type UsageRow = {
  teamId: string;
  actorId: string | null;
  publicModelId: string;
  backendModelId: string;
  providerId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  credits: number;
  usageSource: "upstream" | "estimated";
  statusCode: number | null;
  stream: boolean;
  latencyMs: number | null;
  requestId: string | null;
};

/**
 * Metering. Phase 0/1 write this and nothing else — no balance mutation, no
 * ledger row. Enforcement arrives in Phase 2, after existing teams are
 * back-filled with a starting grant (design §4.8.1).
 *
 * Never allowed to fail the request: the customer already got their tokens, and
 * losing one usage row is cheaper than 500-ing a completed completion.
 */
export async function recordUsage(sql: Sql, u: UsageRow): Promise<void> {
  try {
    await sql`
      insert into amux.ai_usage_logs
        (team_id, actor_id, public_model_id, backend_model_id, provider_id,
         input_tokens, cached_input_tokens, output_tokens, credits,
         usage_source, status_code, stream, latency_ms, request_id)
      values
        (${u.teamId}::uuid, ${u.actorId}::uuid, ${u.publicModelId}, ${u.backendModelId},
         ${u.providerId}, ${u.inputTokens}, ${u.cachedInputTokens}, ${u.outputTokens},
         ${u.credits}, ${u.usageSource}, ${u.statusCode}, ${u.stream},
         ${u.latencyMs}, ${u.requestId})`;
  } catch (err) {
    console.error("[usage] failed to record usage row", err);
  }
}

export async function getBalance(sql: Sql, teamId: string): Promise<number> {
  const rows = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  return rows[0] ? Number(rows[0].balance_credits) : 0;
}
