import { STALE_DEPLOY_MS, isStaleDeploy } from "./app-deploy.js";

/**
 * Reclaiming an abandoned deploy attempt, `deploying` included.
 *
 * A deploy that stopped making progress used to be recoverable only while it
 * was still `awaiting_build`/`building`. Once finalize had claimed the row
 * (`deploying`, lifecycle `in_flight`), the preflight's stale path went through
 * `updateApp(deploy_error)` - which refuses `deploying` - so every retry got
 * `409 this build no longer owns the deploy state`, undeploy got
 * `409 another deployment lifecycle operation is active`, and only hand-written
 * SQL could free the app (Belayo, 2026-11-25: a finalize hung for 4 hours).
 *
 * Why a deploy, unlike an undeploy, may be reclaimed while its provider call is
 * "in flight": the outcome it might have left behind is resolved by deploying
 * again. An undeploy whose outcome is unknown could delete resources twice, so
 * that fence stays with the operator (`report_expired_app_undeploy_calls`). A
 * deploy's worst case is a function already pointing at the new build, which
 * the next deploy overwrites anyway.
 *
 * Two clocks, because they measure different things:
 *  - `apps.deploy_started_at` starts at deploy start, before the build;
 *  - the lifecycle row's `updated_at` is stamped when finalize claims it and
 *    marks it in flight, so a finalize that began late in a long build is not
 *    reclaimed after only a few minutes of work.
 * Both must be older than {@link STALE_DEPLOY_MS}.
 *
 * Each write is conditional on what was read, so a finalize that does finish
 * in the meantime wins: its own writes are keyed on the deploy token, which
 * abandoning the attempt clears (trigger `clear_failed_app_deploy`), and the
 * release below only matches the operation as it was read.
 */

export interface StaleDeployRow {
  fcStatus: string | null;
  deployStartedAt: string | Date | null;
  deployToken: string | null;
}

export interface PendingLifecycleOperation {
  id: string;
  kind: string;
  inFlight: boolean;
  updatedAt: string;
}

export interface ReclaimStore {
  /** The app's one unfinished lifecycle operation, if any. */
  pendingOperation(appId: string): Promise<PendingLifecycleOperation | null>;
  /** Mark it finished, only if it is still exactly as read. True when it was. */
  releaseOperation(op: PendingLifecycleOperation, error: string): Promise<boolean>;
  /** `deploy_error` the attempt, only if the row still holds this status and token. */
  abandonApp(appId: string, expect: { fcStatus: string; deployToken: string | null }, error: string): Promise<boolean>;
}

export type ReclaimOutcome =
  /** Nothing stale here; the caller carries on as before. */
  | "not_stale"
  /** Stale by its start time, but still owned by something live or racing. */
  | "blocked"
  /** The attempt is now `deploy_error` and holds no lock. */
  | "reclaimed";

export function abandonedDeployMessage(fcStatus: string): string {
  return fcStatus === "deploying"
    ? "previous deploy stopped responding while finalizing and was abandoned; the function may or may not have been updated - deploy again"
    : "previous build timed out";
}

export async function reclaimStaleDeploy(
  store: ReclaimStore,
  appId: string,
  row: StaleDeployRow,
  now = Date.now(),
): Promise<ReclaimOutcome> {
  const started = row.deployStartedAt ? new Date(row.deployStartedAt) : null;
  if (!row.fcStatus || !isStaleDeploy(row.fcStatus, started, now)) return "not_stale";
  const fcStatus = row.fcStatus;
  const message = abandonedDeployMessage(fcStatus);

  const op = await store.pendingOperation(appId);
  if (op) {
    // An undeploy or delete owns the app; it is not ours to clear.
    if (op.kind !== "deploy") return "blocked";
    if (op.inFlight && now - new Date(op.updatedAt).getTime() <= STALE_DEPLOY_MS) return "blocked";
    if (!(await store.releaseOperation(op, `reclaimed: ${message}`))) return "blocked";
  }
  // Lifecycle first: an app flipped to deploy_error while its lock stayed
  // would look deployable and then fail in begin_app_lifecycle.
  if (!(await store.abandonApp(appId, { fcStatus, deployToken: row.deployToken }, message))) return "blocked";
  return "reclaimed";
}

/** PostgREST-shaped client, as `serviceRoleClient` returns. */
type Client = { from(table: string): any };

export function supabaseReclaimStore(admin: Client): ReclaimStore {
  return {
    async pendingOperation(appId) {
      const { data, error } = await admin.from("app_lifecycle_operations")
        .select("id, kind, in_flight, updated_at").eq("app_id", appId).neq("status", "succeeded").maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, kind: data.kind, inFlight: data.in_flight === true, updatedAt: data.updated_at } : null;
    },
    async releaseOperation(op, error) {
      const { data, error: err } = await admin.from("app_lifecycle_operations")
        .update({ status: "succeeded", in_flight: false, error, updated_at: new Date().toISOString() })
        .eq("id", op.id).neq("status", "succeeded").eq("in_flight", op.inFlight).eq("updated_at", op.updatedAt)
        .select("id").maybeSingle();
      if (err) throw err;
      return !!data;
    },
    async abandonApp(appId, expect, error) {
      let q = admin.from("apps")
        .update({ fc_status: "deploy_error", provision_error: error, deploy_use_app_code_domain: null, updated_at: new Date().toISOString() })
        .eq("id", appId).eq("fc_status", expect.fcStatus);
      q = expect.deployToken === null ? q.is("deploy_token", null) : q.eq("deploy_token", expect.deployToken);
      const { data, error: err } = await q.select("id").maybeSingle();
      if (err) throw err;
      return !!data;
    },
  };
}
