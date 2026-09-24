import { describe, expect, it } from "vitest";

import {
  canManageAuthorizedHumans,
  canRemoveActor,
} from "../features/actors/actor-management";

describe("actor management", () => {
  it("allows owners and admins to remove other actors", () => {
    expect(
      canRemoveActor({
        actorId: "actor-2",
        currentMemberActorId: "actor-1",
        currentTeamRole: "owner",
      }),
    ).toBe(true);
    expect(
      canRemoveActor({
        actorId: "actor-2",
        currentMemberActorId: "actor-1",
        currentTeamRole: "admin",
      }),
    ).toBe(true);
  });

  it("lets a plain member remove an agent they manage", () => {
    // The server allows it (personal agents need their owning member); the
    // app used to hide the button from anyone below team admin.
    expect(
      canRemoveActor({
        actorId: "agent-1",
        currentMemberActorId: "actor-1",
        currentTeamRole: "member",
        agentAccessRole: "admin",
      }),
    ).toBe(true);
    expect(
      canRemoveActor({
        actorId: "agent-1",
        currentMemberActorId: "actor-1",
        currentTeamRole: "member",
        agentAccessRole: "user",
      }),
    ).toBe(false);
  });

  it("blocks self-removal and non-admin roles", () => {
    expect(
      canRemoveActor({
        actorId: "actor-1",
        currentMemberActorId: "actor-1",
        currentTeamRole: "owner",
      }),
    ).toBe(false);
    expect(
      canRemoveActor({
        actorId: "actor-2",
        currentMemberActorId: "actor-1",
        currentTeamRole: "member",
      }),
    ).toBe(false);
  });

  it("only lets an agent owner manage authorized humans", () => {
    expect(
      canManageAuthorizedHumans({ actorType: "agent", isOwner: true }),
    ).toBe(true);
    expect(
      canManageAuthorizedHumans({ actorType: "agent", isOwner: false }),
    ).toBe(false);
    expect(
      canManageAuthorizedHumans({ actorType: "member", isOwner: true }),
    ).toBe(false);
  });
});
