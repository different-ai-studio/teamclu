import { describe, it, expect } from "vitest";
import {
  buildConfig,
  appDisplayName,
  FALLBACK_BUILD_CONFIG,
  resolveAmuxdDirName,
  resolveDeeplinkSchemes,
} from "@/lib/config/build-config";

describe("build-config auth.webSSO", () => {
  it("defaults webSSO to false in the fallback config", () => {
    // Assert the fallback itself, not the merged `buildConfig`: a local run
    // bakes in build.config.dev.json, which turns webSSO on deliberately, so
    // reading the merged value made this test fail on every dev machine while
    // passing on CI.
    expect(FALLBACK_BUILD_CONFIG.features.auth?.webSSO ?? false).toBe(false);
  });
});

describe("build-config app.displayName", () => {
  it("falls back to app.name when displayName is unset", () => {
    // app.name stays the bundle identity; displayName only overrides the label.
    expect(appDisplayName).toBe(buildConfig.app.displayName ?? buildConfig.app.name);
  });
});

describe("resolveAmuxdDirName", () => {
  it("keeps the official brand on ~/.amuxd and namespaces everything else", () => {
    expect(resolveAmuxdDirName("teamclu")).toBe("amuxd");
    expect(resolveAmuxdDirName("copilot361")).toBe("amuxd-copilot361");
  });

  it("treats the pre-rebrand and dev spellings as white-label", () => {
    // Exactly one name is official (docs/architecture/amuxd-home-layout-v2.md §6).
    // These three used to be official here or in one of the two other copies of
    // the rule, and the disagreement split betly's home state in half.
    expect(resolveAmuxdDirName("teamcludev")).toBe("amuxd-teamcludev");
    expect(resolveAmuxdDirName("teamclaw")).toBe("amuxd-teamclaw");
    expect(resolveAmuxdDirName("teamclawdev")).toBe("amuxd-teamclawdev");
  });
});

describe("resolveDeeplinkSchemes", () => {
  it("keeps the legacy schemes for builds on the default scheme", () => {
    // betly ships without app.scheme, so it lands here too and keeps accepting
    // the amux:// links its backend hands out.
    expect(resolveDeeplinkSchemes(undefined)).toEqual(["teamclu", "teamclaw", "amux"]);
    expect(resolveDeeplinkSchemes("teamclu")).toEqual(["teamclu", "teamclaw", "amux"]);
  });

  it("restricts a build with its own scheme to that scheme alone", () => {
    // copilot361 registers only copilot361:// with the OS — a teamclu:// link
    // would open the official app, never this build.
    expect(resolveDeeplinkSchemes("copilot361")).toEqual(["copilot361"]);
  });
});
