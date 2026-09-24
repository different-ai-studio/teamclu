import { describe, expect, it } from "vitest";

import { sessionRouteForLink } from "../lib/session-deep-link";

describe("sessionRouteForLink", () => {
  it("opens the session for the link Share sends", () => {
    expect(sessionRouteForLink("teamclu://session/abc-123")).toBe("/(app)/sessions/abc-123");
  });

  it("accepts the legacy schemes and the bare path expo-router hands over", () => {
    expect(sessionRouteForLink("teamclaw://session/s1")).toBe("/(app)/sessions/s1");
    expect(sessionRouteForLink("amux://session/s1?x=1")).toBe("/(app)/sessions/s1");
    expect(sessionRouteForLink("/session/s1")).toBe("/(app)/sessions/s1");
    expect(sessionRouteForLink("session/s1")).toBe("/(app)/sessions/s1");
  });

  it("leaves everything else alone", () => {
    expect(sessionRouteForLink("teamclu://invite/tok")).toBeNull();
    expect(sessionRouteForLink("teamclu://auth-callback?code=1")).toBeNull();
    expect(sessionRouteForLink("https://evil.example/session/s1")).toBeNull();
    expect(sessionRouteForLink("teamclu://session/")).toBeNull();
    expect(sessionRouteForLink("teamclu://session/a/b")).toBeNull();
    expect(sessionRouteForLink("teamclu://session/..%2Fsettings")).toBeNull();
    expect(sessionRouteForLink("")).toBeNull();
    expect(sessionRouteForLink(null)).toBeNull();
  });
});
