/**
 * Gitea is TeamClu's forge integration, not part of the app platform.
 *
 * P1 of docs/specs/2026-11-24-app-platform-infra-decoupling-design.md (plan:
 * 2026-11-25-app-platform-p1-gitea-out.md). Everything that knows about Gitea,
 * deploy keys or the git routes lives under `src/lib/forge/`; the rest of the
 * code reaches it only from the composition roots below.
 *
 * Comments are ignored — the scan blanks them out first (string and template
 * literals are kept), so a sentence that mentions Gitea is not an offence but
 * a call, an import path or an error code is.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { stripComments } from "./strip-comments.js";

const SRC = new URL("../../src/", import.meta.url).pathname;
const FORGE = "lib/forge/";

/** Where the forge is wired in for good: the composition roots and team-join sync. */
const ALLOWED = new Set([
  "index.ts",
  "lib/app-platform/deps.ts",
  "lib/routes/index.ts",
  // Joining a team re-syncs its apps' repo access. Team membership is TeamClu,
  // not the platform, so this caller stays.
  "lib/supabase-repo/auth.ts",
]);

/**
 * Files that still reach into the forge directly, and the plan step that takes
 * each one out. Shrinks to empty by P1.4; the second test fails when an entry
 * is no longer needed, so the list cannot rot.
 */
const PENDING: Record<string, string> = {};

const GITEA_TOKEN = /gitea|deploy[-_]?key/i;
/** A relative import path into the forge, e.g. `"../forge/gitea/client.js"`. */
const FORGE_IMPORT_PATH = /["'](?:\.{1,2}\/)+(?:[\w-]+\/)*forge\//;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}


/** `file:line match` for every code reference to the forge (comments excluded). */
function forgeReferences(rel: string, text: string): string[] {
  const hits: string[] = [];
  stripComments(text).split("\n").forEach((line, i) => {
    const m = line.match(GITEA_TOKEN) ?? line.match(FORGE_IMPORT_PATH);
    if (m) hits.push(`${rel}:${i + 1} ${line.trim()}`);
  });
  return hits;
}

function scan(): Map<string, string[]> {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 50, "scanned the source tree");
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const rel = relative(SRC, file);
    if (rel.startsWith(FORGE) || ALLOWED.has(rel)) continue;
    const hits = forgeReferences(rel, readFileSync(file, "utf8"));
    if (hits.length) byFile.set(rel, hits);
  }
  return byFile;
}

test("only lib/forge/ and the composition roots know about Gitea", () => {
  const offences = [...scan()].filter(([rel]) => !(rel in PENDING)).flatMap(([, hits]) => hits);
  assert.deepEqual(offences, [], "move this behind the forge hooks (src/lib/forge/), or wire it from a composition root");
});

test("every pending forge exception is still needed", () => {
  const found = scan();
  const stale = Object.keys(PENDING).filter(rel => !found.has(rel));
  assert.deepEqual(stale, [], "no longer references the forge — drop it from PENDING");
});
