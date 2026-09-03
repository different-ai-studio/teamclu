import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseAtMentionNames, resolveActorIdsFromAtText } from "@/lib/actor/resolve-text-mentions";

const listParticipants = vi.fn();

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: { listParticipants },
  }),
}));

describe("parseAtMentionNames", () => {
  it("extracts @agent tokens and skips file mentions", () => {
    expect(parseAtMentionNames("@MACPRO 再来几个todo")).toEqual(["MACPRO"]);
    expect(parseAtMentionNames("see @{src/foo.ts} and @Bob")).toEqual(["Bob"]);
  });
});

describe("resolveActorIdsFromAtText", () => {
  beforeEach(() => {
    listParticipants.mockReset();
  });

  it("maps display names to participant actor ids", async () => {
    listParticipants.mockResolvedValueOnce([
      { id: "agent-1", actor_type: "agent", display_name: "MACPRO" },
      { id: "member-1", actor_type: "member", display_name: "Hanging" },
    ]);

    const result = await resolveActorIdsFromAtText("session-1", "@MACPRO 再来几个todo");
    expect(result).toEqual({ agentIds: ["agent-1"], memberIds: [] });
  });
});
