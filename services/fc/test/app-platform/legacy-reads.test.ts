/**
 * Nothing reads the legacy app model any more (P3.1 of
 * docs/specs/2026-11-26-app-platform-p3-retire-legacy.md), so P3.4 can drop
 * it: apps.team_id / created_by_actor_id / workspace_id / visibility,
 * app_member_access, and the actor-keyed inheritance functions.
 *
 * What is left are the writes, until P3.2 moves them: TeamClu's create
 * (`writeColumns`) and PATCH (`updateColumns`) write the app row's legacy
 * columns as insert/update objects, which this scan does not look at, and the
 * access tab writes app_member_access (WRITE_POINTS).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { stripComments } from "./strip-comments.js";

const SRC = join(import.meta.dirname, "../../src");
const LEGACY_APP_COLUMNS = ["team_id", "created_by_actor_id", "workspace_id", "visibility"];
const LEGACY_FUNCTIONS = ["app_inherited_agents", "agent_inherited_app_level", "actor_has_app_access", "caller_has_app_grant"];
/** file → how many `app_member_access` references it may hold (the access tab's writes). */
const WRITE_POINTS: Record<string, number> = { "lib/teamclu-apps/repo.ts": 3 };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ rel: relative(SRC, path), code: stripComments(readFileSync(path, "utf8")) }));

test("no select or filter on amux.apps names a legacy column", () => {
  const hits: string[] = [];
  for (const { rel, code } of files) {
    // Each `.from("apps")` chain up to its end: the statement, or the next `.from(`.
    for (const m of code.matchAll(/\.from\(\s*["']apps["']\s*\)([\s\S]*?)(?=;|\n\s*\n|\.from\()/g)) {
      // The app's link (TeamClu's table) is the new home of these columns.
      const chain = m[1].replace(/app_links!inner\([^)]*\)/g, "").replace(/app_links\.\w+/g, "");
      const reads = [...chain.matchAll(/\.(?:select|eq|neq|is|in|not|order)\(\s*(["'`])([\s\S]*?)\1/g)].map((r) => r[2]);
      for (const text of reads) {
        for (const col of LEGACY_APP_COLUMNS) {
          if (new RegExp(`\\b${col}\\b`).test(text)) hits.push(`${rel}: ${col} in "${text.slice(0, 80)}"`);
        }
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("app_member_access is touched only by the access tab's writes", () => {
  const counts: Record<string, number> = {};
  for (const { rel, code } of files) {
    const n = (code.match(/["'`]app_member_access["'`]/g) ?? []).length;
    if (n) counts[rel] = n;
  }
  assert.deepEqual(counts, WRITE_POINTS);
});

test("nothing calls the actor-keyed inheritance functions", () => {
  const hits = files.flatMap(({ rel, code }) =>
    LEGACY_FUNCTIONS.filter((fn) => new RegExp(`["'\`]${fn}["'\`]`).test(code)).map((fn) => `${rel}: ${fn}`));
  assert.deepEqual(hits, []);
});
