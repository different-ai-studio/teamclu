import { describe, expect, it } from "vitest";

import { inboxTopic, parseInboxPing } from "../features/sessions/inbox";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("inboxTopic", () => {
  it("is inbox/<auth user id>, and nothing for a blank id", () => {
    expect(inboxTopic("user-1")).toBe("inbox/user-1");
    expect(inboxTopic("  ")).toBeNull();
  });
});

describe("parseInboxPing", () => {
  it("returns the session id of a v2 ping for the current team", () => {
    expect(
      parseInboxPing(enc({ v: 2, type: "message", team_id: "t1", session_id: "s1", message_id: "m", ts: 1 }), "t1"),
    ).toBe("s1");
  });

  it("accepts a v1 ping with no team or type", () => {
    expect(parseInboxPing(enc({ session_id: "s1" }), "t1")).toBe("s1");
  });

  it("ignores another team's ping, other types, and garbage", () => {
    expect(parseInboxPing(enc({ type: "message", team_id: "t2", session_id: "s1" }), "t1")).toBeNull();
    expect(parseInboxPing(enc({ type: "presence", session_id: "s1" }), "t1")).toBeNull();
    expect(parseInboxPing(enc({ team_id: "t1" }), "t1")).toBeNull();
    expect(parseInboxPing("not json", "t1")).toBeNull();
    expect(parseInboxPing(enc(null), "t1")).toBeNull();
  });
});
