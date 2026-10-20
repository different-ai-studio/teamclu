import { describe, expect, it, vi } from "vitest";

import {
  availableLoginMethods,
  coerceLoginMethod,
  DEFAULT_DESKTOP_DOWNLOAD_URL,
  displayUrl,
  FAIL_OPEN_AUTH_FLAGS,
  fetchPublicConfig,
  parsePublicConfig,
  resolveAuthFlags,
  resolveDesktopDownloadUrl,
} from "../lib/cloud-api/public-config";

describe("parsePublicConfig", () => {
  it("reads the auth flags and the desktop download URL", () => {
    expect(
      parsePublicConfig({
        desktopDownloadUrl: "https://dl.example.com/desktop",
        features: { auth: { google: false, phone: true, password: true, webSSO: true } },
      }),
    ).toEqual({
      authFlags: { google: false, phone: true, password: true },
      desktopDownloadUrl: "https://dl.example.com/desktop",
    });
  });

  it("reads missing keys inside a present auth block as off", () => {
    expect(parsePublicConfig({ features: { auth: { phone: true } } }).authFlags).toEqual({
      google: false,
      phone: true,
      password: false,
    });
  });

  it("returns null flags when there is no auth block at all", () => {
    expect(parsePublicConfig({}).authFlags).toBeNull();
    expect(parsePublicConfig({ features: {} }).authFlags).toBeNull();
    expect(parsePublicConfig(null).authFlags).toBeNull();
  });

  it("rejects a download URL that is not http(s)", () => {
    for (const bad of ["", "   ", "ftp://x.example.com", "javascript:alert(1)", 42, null]) {
      expect(parsePublicConfig({ desktopDownloadUrl: bad }).desktopDownloadUrl).toBeNull();
    }
  });
});

describe("resolvers", () => {
  it("fails open when the server did not answer or sent no auth block", () => {
    expect(resolveAuthFlags(null)).toEqual(FAIL_OPEN_AUTH_FLAGS);
    expect(resolveAuthFlags({ authFlags: null, desktopDownloadUrl: null })).toEqual(
      FAIL_OPEN_AUTH_FLAGS,
    );
  });

  it("lets a server answer switch methods off", () => {
    const flags = { google: false, phone: false, password: false };
    expect(resolveAuthFlags({ authFlags: flags, desktopDownloadUrl: null })).toEqual(flags);
  });

  it("falls back to the built-in download URL", () => {
    expect(resolveDesktopDownloadUrl(null)).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(
      resolveDesktopDownloadUrl({ authFlags: null, desktopDownloadUrl: "https://a.example/x" }),
    ).toBe("https://a.example/x");
  });

  it("strips the scheme for display", () => {
    expect(displayUrl("https://github.com/x/releases")).toBe("github.com/x/releases");
    expect(displayUrl("http://a.example")).toBe("a.example");
    expect(displayUrl("a.example")).toBe("a.example");
  });
});

describe("login methods", () => {
  it("always offers email first, then the enabled optional methods", () => {
    expect(availableLoginMethods(FAIL_OPEN_AUTH_FLAGS)).toEqual(["email", "password", "phone"]);
    expect(availableLoginMethods({ google: true, phone: true, password: false })).toEqual([
      "email",
      "phone",
    ]);
    expect(availableLoginMethods({ google: true, phone: false, password: false })).toEqual([
      "email",
    ]);
  });

  it("falls back to email when the selected method is gated off", () => {
    const off = { google: true, phone: false, password: false };
    expect(coerceLoginMethod("phone", off)).toBe("email");
    expect(coerceLoginMethod("password", off)).toBe("email");
    expect(coerceLoginMethod("phone", FAIL_OPEN_AUTH_FLAGS)).toBe("phone");
  });
});

describe("fetchPublicConfig", () => {
  it("GETs /v1/config/public on the normalized base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ features: { auth: { phone: true } } }),
    });
    const config = await fetchPublicConfig("https://api.example.com/", {
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/v1/config/public",
      expect.objectContaining({ method: "GET" }),
    );
    expect(config?.authFlags).toEqual({ google: false, phone: true, password: false });
  });

  it("returns null on a non-200 or a network failure instead of throwing", async () => {
    const non200 = vi.fn().mockResolvedValue({ status: 503, json: async () => ({}) });
    expect(await fetchPublicConfig("https://a.example", { fetchImpl: non200 as never })).toBeNull();
    const offline = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    expect(await fetchPublicConfig("https://a.example", { fetchImpl: offline as never })).toBeNull();
  });
});
