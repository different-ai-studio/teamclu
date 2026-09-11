/**
 * App type — what it means, and request validation.
 *
 * `type` is written at create and, since the control panel, editable through
 * `PATCH /v1/apps/:appId`. What it changes on the server is one decision made at
 * finalize — {@link needsDatabase} — so an edit reaches the running app only on
 * the next deploy. The row's `typePendingRedeploy` (supabase-repo/shared.ts) is
 * how the operator learns that.
 */

import { ApiError } from "../http-utils.js";

/**
 * The values a client may SET. Deliberately narrower than what the column can
 * hold: `fullstack_tanstack_postgres` is still stored on apps created before the
 * split, but nobody may write it again — `data_app` is the same thing.
 */
export const APP_TYPES = ["static_web", "slides", "data_app", "imported"] as const;
export type AppType = (typeof APP_TYPES)[number];

/**
 * Only data apps get a Postgres schema; the other types are static files.
 *
 * `imported` is listed explicitly rather than left to the default: an app whose
 * code came from someone else's repo is not a data app, and defaulting it there
 * made every imported repo demand a Postgres schema (and the team's org id) on
 * its first deploy. Everything still-unrecognized stays `data_app`, which is
 * what apps created before types existed actually are — the legacy id
 * `fullstack_tanstack_postgres` included.
 */
export function needsDatabase(appType: string): boolean {
  const t = appType.trim();
  return t !== "static_web" && t !== "slides" && t !== "imported";
}

/**
 * `undefined` when the patch does not mention `type`; otherwise exactly one of
 * {@link APP_TYPES} or a 400.
 *
 * `null` is refused rather than read as "no change": the column is NOT NULL, so
 * there is nothing to clear it to, and a client that sends one has a bug worth
 * hearing about. No trimming either — these are ids, not free text.
 */
export function parseAppType(raw: unknown): AppType | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(APP_TYPES as readonly string[]).includes(raw)) {
    throw new ApiError(400, "validation_failed", `type must be one of: ${APP_TYPES.join(", ")}`);
  }
  return raw as AppType;
}

/**
 * Whether deploying now would build a different function than the one the
 * app was last deployed as.
 *
 * The database is the only thing a type decides at deploy, so this compares
 * that and nothing else. Switching among `static_web`, `slides` and `imported`
 * changes the label and the starter template, neither of which a redeploy
 * touches — telling the operator to redeploy for it would be a warning about
 * nothing. The legacy id falls out of the same rule: it needs a database, so a
 * pre-split app re-saved as `data_app` is the app it was.
 */
export function typeChangeNeedsRedeploy(deployedType: string, currentType: string): boolean {
  return needsDatabase(deployedType) !== needsDatabase(currentType);
}
