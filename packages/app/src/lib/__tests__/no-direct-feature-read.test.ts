import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guardrail: feature flags must be read through lib/config/remote-features, never
// straight off `buildConfig.features`.
//
// The build config is now only the DEFAULT — the Cloud API overrides it at
// runtime. A direct read is not merely inconsistent, it is unobservable: the
// old `const channels = resolveChannelsConfig(buildConfig.features.channels)`
// at module scope in ChannelsSection could never see a flag that arrived after
// import, and nothing about that code looked wrong.

const SELF = path.resolve(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(path.dirname(SELF), "..", "..");

const DIRECT_READ_RE = /\bbuildConfig\s*(\?\.|\.)\s*features\b/;

// remote-features is the one place allowed to read the defaults, and the build
// config module itself declares them.
const ALLOWED = new Set(
  [
    path.join(SRC_DIR, "lib", "config", "remote-features.ts"),
    path.join(SRC_DIR, "lib", "build-config.ts"),
  ].map((p) => path.resolve(p)),
);

// Tests are exempt: the rule is about shipped behaviour, and a test that pins
// the baked defaults (mocking @/lib/config/build-config to force a flag on, as the
// OAuthButtons suite does) is doing exactly the right thing.
const IS_TEST = /(^|[\\/])__tests__[\\/]|\.test\.tsx?$/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe("guardrail: feature flags are read through remote-features", () => {
  it("detects the direct-read pattern", () => {
    expect(DIRECT_READ_RE.test("buildConfig.features.apps")).toBe(true);
    expect(DIRECT_READ_RE.test("buildConfig.features?.auth?.phone")).toBe(true);
    expect(DIRECT_READ_RE.test("buildConfig?.features")).toBe(true);
    expect(DIRECT_READ_RE.test("buildConfig.app.name")).toBe(false);
  });

  it("no source file outside remote-features reads buildConfig.features", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of walk(SRC_DIR)) {
      if (ALLOWED.has(path.resolve(file)) || IS_TEST.test(file)) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, idx) => {
          if (DIRECT_READ_RE.test(text)) {
            offenders.push({ file: path.relative(SRC_DIR, file), line: idx + 1, text: text.trim() });
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
