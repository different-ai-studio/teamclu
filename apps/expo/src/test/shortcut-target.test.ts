import { describe, expect, it, vi } from "vitest";

// Mock React Native and Expo modules that cannot run in Node
vi.mock("react-native", () => ({
  StyleSheet: { create: (s: unknown) => s },
  Animated: { Value: class {}, timing: vi.fn(), spring: vi.fn() },
  Easing: {},
  Pressable: {},
  ScrollView: {},
  Text: {},
  View: {},
  ActivityIndicator: {},
  useWindowDimensions: () => ({ width: 375, height: 812 }),
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo-linking", () => ({ canOpenURL: vi.fn(), openURL: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../lib/auth/cloud-auth", () => ({ cloudAuth: {} }));
vi.mock("../ui/atoms/Hairline", () => ({ Hairline: {} }));
vi.mock("../ui/theme", () => ({
  colors: { slate: "#888", text: "#000", bg: "#fff" },
  hai: { pebble: "#ccc", fog: "#eee", ink: "#111" },
  radii: { sm: 4, md: 8, lg: 16 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24 },
  typography: {
    sans: { fontFamily: "System" },
    serif: { fontFamily: "System" },
    mono: { fontFamily: "Courier" },
    caption: { fontFamily: "System", fontSize: 12 },
    body: { fontFamily: "System", fontSize: 14 },
  },
}));
vi.mock("../features/shortcuts/api-provider", () => ({ createConfiguredShortcutsApi: vi.fn() }));

import { openShortcutTarget } from "../features/shortcuts/ShortcutsDrawer";
import type { Shortcut } from "../features/shortcuts/shortcut-types";

function shortcut(over: Partial<Shortcut>): Shortcut {
  return {
    id: "x", scope: "team", parentId: null, label: "X", nodeType: "url",
    target: "", order: 0, ...over,
  } as Shortcut;
}

describe("openShortcutTarget", () => {
  it("routes a session shortcut to the session route", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "session", target: "session-123" }), router);
    expect(router.push).toHaveBeenCalledWith("/(app)/sessions/session-123");
  });

  it("routes a url shortcut to the in-app webview modal", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "url", target: "https://example.com", label: "Hi" }), router);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(app)/shortcut-web",
      params: { url: "https://example.com", title: "Hi" },
    });
  });

  it("routes an external shortcut through the webview as well", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "external", target: "https://example.com" }), router);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(app)/shortcut-web",
      params: { url: "https://example.com", title: "X" },
    });
  });
});

describe("isWebUrl", () => {
  it("accepts the two schemes a WebView should load", async () => {
    const { isWebUrl } = await import("../features/shortcuts/ShortcutsDrawer");
    expect(isWebUrl("https://example.test/docs")).toBe(true);
    expect(isWebUrl("http://example.test")).toBe(true);
    expect(isWebUrl("HTTPS://EXAMPLE.TEST")).toBe(true);
  });

  it("refuses schemes that are not links", async () => {
    // Shortcut targets are team data — whoever creates the shortcut picks the
    // string, and it used to reach `WebView source={{ uri }}` unexamined.
    const { isWebUrl } = await import("../features/shortcuts/ShortcutsDrawer");
    for (const target of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "teamclu://sessions/1",
    ]) {
      expect(isWebUrl(target)).toBe(false);
    }
  });

  it("refuses anything without a scheme, and empty input", async () => {
    const { isWebUrl } = await import("../features/shortcuts/ShortcutsDrawer");
    expect(isWebUrl("example.test/docs")).toBe(false);
    expect(isWebUrl("/relative/path")).toBe(false);
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl(null)).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});

describe("openShortcutTarget scheme guard", () => {
  it("does not open a url shortcut whose target is not http(s)", async () => {
    const { openShortcutTarget } = await import("../features/shortcuts/ShortcutsDrawer");
    const pushed: unknown[] = [];
    const router = { push: (href: unknown) => pushed.push(href) };
    await openShortcutTarget(
      { id: "s", label: "Bad", icon: null, nodeType: "url", target: "javascript:alert(1)", order: 0, parentId: null, scope: "team" },
      router,
    );
    expect(pushed).toEqual([]);
  });
});

describe("ShortcutsDrawer hooks order", () => {
  it("does not call hooks after the mounted early-return", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../features/shortcuts/ShortcutsDrawer.tsx",
      ),
      "utf8",
    );
    const fnStart = source.indexOf("export function ShortcutsDrawer");
    const fnBody = source.slice(fnStart);
    // Stop before nested helpers so we only inspect ShortcutsDrawer itself.
    const end = fnBody.indexOf("\nfunction ProfileHeader");
    const body = end >= 0 ? fnBody.slice(0, end) : fnBody;
    const earlyReturn = body.search(/if\s*\(\s*!mounted\s*\)\s*return\s+null/);
    expect(earlyReturn).toBeGreaterThan(-1);
    const after = body.slice(earlyReturn);
    expect(after).not.toMatch(/\buse(State|Memo|Effect|Ref|Callback)\s*[<(]/);
  });
});
