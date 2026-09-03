import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OFFICIAL_BRAND_SHORT_NAME, isOfficialBrand } from "@/lib/config/build-config";

/**
 * The brand table has exactly one definition, in Rust
 * (`teamclu_runtime_env::storage_namespace`). The frontend cannot import it —
 * different toolchain — so it mirrors the one string, and this test holds the
 * mirror against the source.
 *
 * It is here because the alternative already failed in production: three
 * hand-maintained copies of `is_official_brand`, two of which disagreed with
 * the third, which is how a betly build read its secrets from `~/.teamclu`
 * while writing its cache to `~/.teamclaw`. A codegen step for one string is
 * not worth it; a test that fails when the Rust side moves is.
 *
 * Spec: `docs/architecture/amuxd-home-layout-v2.md` §6.
 */

const RUST_SOURCE = "crates/teamclu-runtime-env/src/storage_namespace.rs";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, RUST_SOURCE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate ${RUST_SOURCE} above ${import.meta.url}`);
}

function rustSource(): string {
  return readFileSync(join(repoRoot(), RUST_SOURCE), "utf8");
}

describe("brand table parity with teamclu-runtime-env", () => {
  it("mirrors OFFICIAL_STORAGE_DIR", () => {
    const match = rustSource().match(
      /pub const OFFICIAL_STORAGE_DIR: &str = "([^"]+)";/,
    );
    expect(match, "OFFICIAL_STORAGE_DIR not found in the Rust source").toBeTruthy();
    expect(match![1]).toBe(OFFICIAL_BRAND_SHORT_NAME);
  });

  it("mirrors is_official_brand's single-name rule", () => {
    // Whitespace-insensitive so rustfmt cannot break the test, but otherwise
    // exact: widening the Rust rule (adding a name, switching to `matches!`)
    // fails here until this file and `isOfficialBrand` are updated with it.
    const body = rustSource()
      .split("pub fn is_official_brand(short_name: &str) -> bool {")[1]
      ?.split("}")[0]
      ?.replace(/\s+/g, " ")
      .trim();

    expect(body).toBe("short_name == OFFICIAL_STORAGE_DIR");
  });

  it("classifies the names that used to disagree", () => {
    expect(isOfficialBrand("teamclu")).toBe(true);
    for (const name of ["teamcludev", "teamclaw", "teamclawdev", "copilot361"]) {
      expect(isOfficialBrand(name), `${name} must be white-label`).toBe(false);
    }
  });
});
