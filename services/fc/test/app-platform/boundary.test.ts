/**
 * The app platform reaches its cloud only through `src/lib/app-platform/`.
 *
 * Fails when code elsewhere constructs an app-platform SDK client again — the
 * thing P0 of docs/specs/2026-11-24-app-platform-infra-decoupling-design.md
 * removed. Route the call through `resolveAppPlatform()` instead.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SRC = new URL("../../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

/** Where each guarded construct may appear: only the Aliyun provider. */
const ALIYUN = "lib/app-platform/aliyun/";
const RULES: Array<{ pattern: RegExp; allowed: string[]; what: string; wholeFile?: true }> = [
  {
    what: "an app-platform SDK client constructor or ops factory",
    pattern: /\b(getFcClient|getSlsClient|getAppsS3Client|makeFcOps|makeSlsOps|makeAppStorageOps)\s*\(/,
    allowed: [ALIYUN],
  },
  {
    what: "the Function Compute or SLS SDK",
    pattern: /from\s+["']@alicloud\/(fc20230330|sls20201230)["']/,
    allowed: [ALIYUN],
  },
  {
    what: "a value import from the Aliyun provider (go through resolveAppPlatform())",
    // `import type` is fine: the driver interfaces still borrow a few shapes.
    // Whole statements, so a multi-line `import {…} from` is seen as one.
    pattern: /^import\s+(?!type\b)[^;]*?from\s+["'](?:\.\/|[^"']*app-platform\/)aliyun\/[^"']*["']/gm,
    wholeFile: true,
    allowed: [ALIYUN, "lib/app-platform/index.ts"],
  },
];

test("only app-platform/ reaches the app platform's cloud SDKs", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 50, "scanned the source tree");
  const offences: string[] = [];
  for (const file of files) {
    const rel = relative(SRC, file);
    const text = readFileSync(file, "utf8");
    for (const rule of RULES) {
      if (rule.allowed.some(a => (a.endsWith("/") ? rel.startsWith(a) : rel === a))) continue;
      if (rule.wholeFile) {
        for (const m of text.matchAll(rule.pattern)) {
          const line = text.slice(0, m.index).split("\n").length;
          offences.push(`${rel}:${line} uses ${rule.what}: ${m[0].replace(/\s+/g, " ")}`);
        }
        continue;
      }
      text.split("\n").forEach((line, i) => {
        if (rule.pattern.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
          offences.push(`${rel}:${i + 1} uses ${rule.what}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offences, [], "use resolveAppPlatform() from src/lib/app-platform instead");
});
