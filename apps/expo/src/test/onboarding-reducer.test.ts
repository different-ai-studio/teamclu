import { describe, expect, it } from "vitest";

import {
  initialOnboardingState,
  onboardingReducer,
} from "../features/onboarding/onboarding-reducer";
import type { BootstrapResult, TeamSummary } from "../features/onboarding/onboarding-types";

describe("onboardingReducer", () => {
  it("stores pending email after otpRequested", () => {
    const state = onboardingReducer(initialOnboardingState, {
      type: "otpRequested",
      email: "person@example.com",
    });

    expect(state.pendingEmailOTPEmail).toBe("person@example.com");
  });

  it("sets isBusy during beginBusy and clears an existing error", () => {
    const state = onboardingReducer(
      {
        ...initialOnboardingState,
        errorMessage: "Previous error",
      },
      {
        type: "beginBusy",
      },
    );

    expect(state.isBusy).toBe(true);
    expect(state.errorMessage).toBeNull();
  });

  it("sets createTeam when bootstrapResolved has no team and preserves isAnonymous", () => {
    const bootstrapResult: BootstrapResult = {
      isAnonymous: true,
      team: null,
      teamChoices: [],
      memberActorId: null,
    };

    const state = onboardingReducer(
      {
        ...initialOnboardingState,
        isAnonymous: false,
        pendingEmailOTPEmail: "person@example.com",
      },
      {
        type: "bootstrapResolved",
        payload: bootstrapResult,
      },
    );

    expect(state.route).toBe("createTeam");
    expect(state.isAnonymous).toBe(true);
    expect(state.pendingEmailOTPEmail).toBeNull();
    expect(state.currentTeam).toBeNull();
    expect(state.currentMemberActorId).toBeNull();
  });

  it("sets ready when bootstrapResolved has a team and stores team context", () => {
    const team: TeamSummary = {
      id: "team_123",
      name: "Team Claw",
      slug: "team-claw",
      role: "owner",
    };
    const bootstrapResult: BootstrapResult = {
      isAnonymous: false,
      team,
      teamChoices: [],
      memberActorId: "actor_123",
    };

    const state = onboardingReducer(initialOnboardingState, {
      type: "bootstrapResolved",
      payload: bootstrapResult,
    });

    expect(state.route).toBe("ready");
    expect(state.currentTeam).toEqual(team);
    expect(state.currentMemberActorId).toBe("actor_123");
    expect(state.isAnonymous).toBe(false);
  });

  it("sets failed when bootstrapFailed and clears stale session context", () => {
    const state = onboardingReducer(
      {
        ...initialOnboardingState,
        route: "ready",
    teamChoices: [],
        isBusy: true,
        errorMessage: null,
        pendingEmailOTPEmail: "person@example.com",
        currentTeam: {
          id: "team_123",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        currentMemberActorId: "actor_123",
        isAnonymous: true,
      },
      {
        type: "bootstrapFailed",
        message: "Bootstrap exploded",
      },
    );

    expect(state.route).toBe("failed");
    expect(state.isBusy).toBe(false);
    expect(state.errorMessage).toBe("Bootstrap exploded");
    expect(state.pendingEmailOTPEmail).toBeNull();
    expect(state.currentTeam).toBeNull();
    expect(state.currentMemberActorId).toBeNull();
    expect(state.isAnonymous).toBe(false);
  });

  it("resets to auth state when signedOut", () => {
    const state = onboardingReducer(
      {
        ...initialOnboardingState,
        route: "ready",
    teamChoices: [],
        isBusy: true,
        errorMessage: "Oops",
        pendingEmailOTPEmail: "person@example.com",
        currentTeam: {
          id: "team_123",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        currentMemberActorId: "actor_123",
        isAnonymous: false,
      },
      {
        type: "signedOut",
      },
    );

    expect(state.route).toBe("needsAuth");
    expect(state.isBusy).toBe(false);
    expect(state.errorMessage).toBeNull();
    expect(state.pendingEmailOTPEmail).toBeNull();
    expect(state.currentTeam).toBeNull();
    expect(state.currentMemberActorId).toBeNull();
    expect(state.isAnonymous).toBe(false);
  });
});
