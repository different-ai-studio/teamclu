import { describe, expect, it, vi } from "vitest";

import {
  downloadProgress,
  fetchAndroidUpdateManifest,
  isUpdateAvailable,
  parseAndroidUpdateManifest,
  parseInstalledVersionCode,
  shouldCheckForUpdate,
  type AndroidUpdateManifest,
} from "../features/updates/android-update";

const manifest = (over: Partial<AndroidUpdateManifest> = {}): AndroidUpdateManifest => ({
  version: "0.1.0-5",
  versionCode: 5,
  url: "https://teamclaw.ucar.cc/beta/android/0.1.0-5/TeamClu_0.1.0-5.apk",
  size: 1000,
  sha256: "abc",
  notes: "fix",
  ...over,
});

describe("parseAndroidUpdateManifest", () => {
  it("accepts what publish-android-apk.py writes", () => {
    expect(
      parseAndroidUpdateManifest({
        version: "0.1.0-5",
        versionCode: 5,
        url: "https://cdn/x.apk",
        size: 10,
        sha256: "h",
        notes: "n",
        pub_date: "2026-10-13T00:00:00+00:00",
      }),
    ).toEqual({ version: "0.1.0-5", versionCode: 5, url: "https://cdn/x.apk", size: 10, sha256: "h", notes: "n" });
  });

  it("rejects a missing or non-positive versionCode", () => {
    expect(parseAndroidUpdateManifest({ version: "1", url: "https://cdn/x.apk" })).toBeNull();
    expect(parseAndroidUpdateManifest({ version: "1", versionCode: null, url: "https://cdn/x.apk" })).toBeNull();
    expect(parseAndroidUpdateManifest({ version: "1", versionCode: 0, url: "https://cdn/x.apk" })).toBeNull();
  });

  it("rejects a non-https download url", () => {
    expect(parseAndroidUpdateManifest({ version: "1", versionCode: 2, url: "http://cdn/x.apk" })).toBeNull();
    expect(parseAndroidUpdateManifest({ version: "1", versionCode: 2, url: "javascript:alert(1)" })).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    expect(parseAndroidUpdateManifest({ version: "1", versionCode: "2", url: "https://cdn/x.apk" })).toEqual({
      version: "1",
      versionCode: 2,
      url: "https://cdn/x.apk",
      size: 0,
      sha256: "",
      notes: "",
    });
  });

  it("rejects garbage", () => {
    expect(parseAndroidUpdateManifest(null)).toBeNull();
    expect(parseAndroidUpdateManifest("x")).toBeNull();
  });
});

describe("parseInstalledVersionCode", () => {
  it("reads expo-application's string build number", () => {
    expect(parseInstalledVersionCode("4")).toBe(4);
  });

  it("is unknown for dev or unreadable values", () => {
    expect(parseInstalledVersionCode(null)).toBeNull();
    expect(parseInstalledVersionCode(undefined)).toBeNull();
    expect(parseInstalledVersionCode("")).toBeNull();
    expect(parseInstalledVersionCode("1.0")).toBe(1);
    expect(parseInstalledVersionCode("abc")).toBeNull();
  });
});

describe("isUpdateAvailable", () => {
  it("offers only a strictly newer versionCode", () => {
    expect(isUpdateAvailable(manifest({ versionCode: 5 }), 4)).toBe(true);
    expect(isUpdateAvailable(manifest({ versionCode: 5 }), 5)).toBe(false);
    expect(isUpdateAvailable(manifest({ versionCode: 5 }), 6)).toBe(false);
  });

  it("never offers when the installed version is unknown", () => {
    expect(isUpdateAvailable(manifest(), null)).toBe(false);
    expect(isUpdateAvailable(null, 1)).toBe(false);
  });

  it("stays quiet for a dismissed version but shows a newer one", () => {
    expect(isUpdateAvailable(manifest({ versionCode: 5 }), 4, 5)).toBe(false);
    expect(isUpdateAvailable(manifest({ versionCode: 6 }), 4, 5)).toBe(true);
  });
});

describe("shouldCheckForUpdate", () => {
  it("checks first time and after the interval only", () => {
    expect(shouldCheckForUpdate(null, 1000)).toBe(true);
    expect(shouldCheckForUpdate(1000, 1500, 1000)).toBe(false);
    expect(shouldCheckForUpdate(1000, 2000, 1000)).toBe(true);
  });
});

describe("fetchAndroidUpdateManifest", () => {
  it("busts the CDN cache and parses the body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(manifest()), { status: 200 }));
    const out = await fetchAndroidUpdateManifest("https://cdn/beta/android/latest.json", fetchImpl as typeof fetch);
    expect(out?.versionCode).toBe(5);
    const calledUrl = (fetchImpl.mock.calls[0] as unknown as [string])[0];
    expect(calledUrl).toMatch(/^https:\/\/cdn\/beta\/android\/latest\.json\?t=\d+$/);
  });

  it("is null when there is no manifest yet", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    expect(await fetchAndroidUpdateManifest("https://cdn/x.json", fetchImpl as typeof fetch)).toBeNull();
  });
});

describe("downloadProgress", () => {
  it("clamps to [0, 1] and handles an unknown total", () => {
    expect(downloadProgress(50, 100)).toBe(0.5);
    expect(downloadProgress(150, 100)).toBe(1);
    expect(downloadProgress(10, 0)).toBe(0);
    expect(downloadProgress(10, -1)).toBe(0);
  });
});
