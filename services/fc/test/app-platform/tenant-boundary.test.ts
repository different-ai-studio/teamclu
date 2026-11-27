/**
 * The app platform knows orgs and accounts, not TeamClu's teams, actors,
 * members, workspaces or sessions.
 *
 * P2.4c of docs/specs/2026-11-25-app-platform-p2-de-team.md (exit criterion 1
 * of P2 in the parent spec). The platform is `src/lib/app-platform/` and
 * `src/lib/provisioning/`; TeamClu reaches it through `AppTenantHooks`
 * (`app-platform/tenant.ts`, implemented in `src/lib/teamclu-apps/`).
 *
 * The scan works on words, not substrings: identifiers and string contents
 * are split at `_`, `-` and camelCase, so `tenantFactory` is not an "actor"
 * and `updated_by_member_id` is a "member". The brand name (TeamClu, teamclu,
 * TEAMCLU_…) is removed first. Singular "session" is allowed — an STS role
 * session or a migration's SQL session is not TeamClu's; the TeamClu table is
 * `sessions`. Comments are ignored, as in forge-boundary.test.ts.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { stripComments } from "./strip-comments.js";

const SRC = new URL("../../src/", import.meta.url).pathname;
const PLATFORM = ["lib/app-platform/", "lib/provisioning/"];

const FORBIDDEN = new Set([
  "team", "teams", "actor", "actors", "member", "members", "membership",
  "workspace", "workspaces", "sessions",
]);

/**
 * Words still in the platform, per file, and what takes each out. The second
 * test fails when an entry is no longer needed, so the list cannot rot.
 */
const PENDING: Record<string, { words: string[]; until: string }> = {
  "lib/app-platform/service/apps.ts": {
    // Cleared on every env write so P2.1's trigger never copies an older
    // member writer's account over the one written; the column goes in P3.
    words: ["updated_by_member_id"],
    until: "P3 drops app_env_vars.updated_by_member_id",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

/** Every identifier-like run in the code, with the words it splits into. */
export function offendingTokens(code: string): string[] {
  const out = new Set<string>();
  const debranded = code.replace(/teamclu/gi, " ");
  for (const token of debranded.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    const words = token
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_]+/)
      .map(w => w.toLowerCase());
    if (words.some(w => FORBIDDEN.has(w))) out.add(token);
  }
  return [...out].sort();
}

function scan(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of PLATFORM) {
    for (const path of sourceFiles(join(SRC, dir))) {
      const rel = relative(SRC, path);
      const tokens = offendingTokens(stripComments(readFileSync(path, "utf8")));
      if (tokens.length) found.set(rel, tokens);
    }
  }
  return found;
}

test("the word split catches TeamClu's terms and spares the rest", () => {
  assert.deepEqual(offendingTokens("const tenantFactory = teamId + created_by_actor_id;"), ["created_by_actor_id", "teamId"]);
  assert.deepEqual(offendingTokens('RoleSessionName; TEAMCLU_APP_ID; "sessions"; MigrationSession'), ["sessions"]);
});

test("the app platform names no team, actor, member, workspace or sessions", () => {
  const offences: string[] = [];
  for (const [file, tokens] of scan()) {
    const allowed = new Set(PENDING[file]?.words ?? []);
    const extra = tokens.filter(t => !allowed.has(t));
    if (extra.length) offences.push(`${file}: ${extra.join(", ")}`);
  }
  assert.deepEqual(offences, [], "move these behind AppTenantHooks (src/lib/teamclu-apps/)");
});

test("every pending entry is still needed", () => {
  const found = scan();
  const stale = Object.entries(PENDING).flatMap(([file, { words }]) =>
    words.filter(w => !(found.get(file) ?? []).includes(w)).map(w => `${file}: ${w}`));
  assert.deepEqual(stale, [], "remove these from PENDING");
});
