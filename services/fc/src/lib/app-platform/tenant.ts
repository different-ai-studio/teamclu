/**
 * What the app platform asks the product it is embedded in about the apps it
 * keeps.
 *
 * The platform knows orgs (the tenant) and accounts (who acts). The product —
 * TeamClu today — has its own way of grouping people and its own fields that
 * its clients expect on an app; those stay on its side of this interface
 * (P2.4b of docs/specs/2026-11-25-app-platform-p2-de-team.md, decision Q6).
 * TeamClu's implementation is `teamclu-apps/tenant.ts`.
 *
 * Until P3 drops the legacy columns, the product's columns still sit on the
 * app row, so several hooks hand back columns for the platform to write.
 */

export interface AppTenantCreate {
  /** The org the new app belongs to. */
  orgId: string;
  /**
   * The product's columns for the app row, written with the platform's. Called
   * after every check has passed, just before the insert — the product may
   * create what the columns point at here.
   */
  writeColumns(ctx: { slug: string }): Promise<Record<string, unknown>>;
  /** Called once the row exists; best-effort work the product does for a new app. */
  created(row: Record<string, any>): Promise<void>;
}

export interface AppTenantHooks {
  /**
   * Authorize a new app and settle which org it is in. `input` is the create
   * request as the route received it. Throws an ApiError to refuse (not
   * allowed here, no org, …); writes nothing.
   */
  prepareCreate(input: Record<string, any>): Promise<AppTenantCreate>;

  /**
   * Narrow a list query by the product's own arguments — every list argument
   * except `limit` and `cursor`. Row security has already limited it to what
   * the caller may see.
   */
  scopeList<Q>(query: Q, scope: Record<string, unknown>): Q;

  /**
   * Extra response fields for apps the caller reads, one object per row, in
   * the same order. Must not fail the read.
   */
  decorate(rows: Record<string, any>[]): Promise<Record<string, unknown>[]>;

  /** Columns an update writes for the product's own fields of the patch. */
  updateColumns(patch: Record<string, unknown>): Record<string, unknown>;

  /**
   * Which of those columns decide who may reach the app (an org grant, say).
   * Changing one is managing access, which a caller whose level came through
   * a delegation may not do — the same rule as the grant routes.
   */
  readonly accessColumns?: readonly string[];

  /** Extra fields for an app's auth info (`GET /v1/apps/:id/auth-info`). */
  authInfoFields(app: Record<string, any>): Record<string, unknown>;

  /**
   * The app's row is about to be deleted and its repo has been retired
   * (`archivedRepoUrl` is where the code now lives, if anywhere). Release what
   * the product attached to the app. `admin` is a service-role client.
   */
  appDeleting(appId: string, ctx: { admin: any; archivedRepoUrl: string | null; remoteUrl: string | null }): Promise<void>;
}

/** Built per repository, with the repository itself (for its other methods). */
export type AppTenantHooksFactory = (repo: any) => AppTenantHooks;
