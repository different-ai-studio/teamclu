import { describe, expect, it } from "vitest";

import { mqttConnectionKey } from "@/lib/mqtt/mqtt-connection-key";

describe("mqttConnectionKey", () => {
  it("changes when the access token changes", () => {
    const base = {
      userId: "user-1",
      teamId: "team-1",
    };

    expect(
      mqttConnectionKey({ ...base, accessToken: "token-old" }),
    ).not.toBe(mqttConnectionKey({ ...base, accessToken: "token-new" }));
  });

  it("is unavailable until user, team, and access token are all present", () => {
    expect(
      mqttConnectionKey({
        userId: "user-1",
        teamId: "team-1",
        accessToken: null,
      }),
    ).toBeNull();
  });
});
