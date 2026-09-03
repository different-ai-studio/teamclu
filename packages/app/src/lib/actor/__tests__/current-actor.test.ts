import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentMemberActorId } from "@/lib/actor/current-actor";

const resolveCurrentMemberActor = vi.fn();

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    directory: { resolveCurrentMemberActor },
  }),
}));

beforeEach(() => {
  resolveCurrentMemberActor.mockReset();
});

describe("resolveCurrentMemberActorId", () => {
  it("uses current team member hint without querying Supabase", async () => {
    await expect(
      resolveCurrentMemberActorId("team-1", "user-1", {
        currentTeamId: "team-1",
        currentMemberId: "actor-self",
      }),
    ).resolves.toBe("actor-self");

    expect(resolveCurrentMemberActor).not.toHaveBeenCalled();
  });

  it("uses backend directory resolution without a hint", async () => {
    resolveCurrentMemberActor.mockResolvedValue({ id: "actor-directory-self" });

    await expect(
      resolveCurrentMemberActorId("team-1", "user-1"),
    ).resolves.toBe("actor-directory-self");

    expect(resolveCurrentMemberActor).toHaveBeenCalledWith("team-1", "user-1");
  });

  it("returns null when backend directory has no member actor", async () => {
    resolveCurrentMemberActor.mockResolvedValue(null);

    await expect(
      resolveCurrentMemberActorId("team-1", "user-1"),
    ).resolves.toBeNull();
  });
});
