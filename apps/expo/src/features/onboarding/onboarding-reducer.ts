import { resolveBootstrapLanding } from "./bootstrap-route";
import type { OnboardingAction, OnboardingState } from "./onboarding-types";

export const initialOnboardingState: OnboardingState = {
  route: "loading",
  teamChoices: [],
  identityChoices: [],
  isBusy: false,
  errorMessage: null,
  pendingEmailOTPEmail: null,
  pendingPhoneOTPPhone: null,
  phoneAccounts: [],
  pendingInvites: [],
  currentTeam: null,
  currentMemberActorId: null,
  isAnonymous: false,
};

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "beginBusy":
      return {
        ...state,
        isBusy: true,
        errorMessage: null,
      };
    case "clearError":
      return {
        ...state,
        errorMessage: null,
      };
    case "otpRequested":
      return {
        ...state,
        pendingEmailOTPEmail: action.email,
        pendingPhoneOTPPhone: null,
        isBusy: false,
      };
    case "resetPendingEmail":
      return {
        ...state,
        pendingEmailOTPEmail: null,
        errorMessage: null,
      };
    case "phoneOtpRequested":
      return {
        ...state,
        pendingPhoneOTPPhone: action.phone,
        pendingEmailOTPEmail: null,
        phoneAccounts: [],
        isBusy: false,
      };
    case "resetPendingPhone":
      return {
        ...state,
        pendingPhoneOTPPhone: null,
        phoneAccounts: [],
        errorMessage: null,
      };
    case "phoneAccountsOffered":
      return {
        ...state,
        phoneAccounts: action.accounts,
        isBusy: false,
      };
    case "phoneAccountsDismissed":
      return {
        ...state,
        phoneAccounts: [],
      };
    case "pendingInvitesLoaded":
      return {
        ...state,
        pendingInvites: action.invites,
      };
    case "bootstrapResolved":
      return {
        ...state,
        // Four outcomes. A null team with choices means the bootstrap stopped
        // to ask; a null team without them is create — or, for someone who
        // said they are joining, the no-team screen.
        route: resolveBootstrapLanding({
          hasTeam: action.payload.team !== null,
          teamChoiceCount: action.payload.teamChoices.length,
          intent: action.intent,
        }),
        teamChoices: action.payload.teamChoices,
        identityChoices: [],
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: null,
        pendingPhoneOTPPhone: null,
        phoneAccounts: [],
        currentTeam: action.payload.team,
        currentMemberActorId: action.payload.memberActorId,
        isAnonymous: action.payload.isAnonymous,
      };
    case "bootstrapFailed":
      return {
        ...state,
        route: "failed",
        teamChoices: [],
        identityChoices: [],
        isBusy: false,
        errorMessage: action.message,
        pendingEmailOTPEmail: null,
        pendingPhoneOTPPhone: null,
        phoneAccounts: [],
        currentTeam: null,
        currentMemberActorId: null,
        isAnonymous: false,
      };
    case "teamSelectionFailed":
      return {
        ...state,
        route: "selectTeam",
        isBusy: false,
        errorMessage: action.message,
      };
    case "identitiesOffered":
      return {
        ...state,
        route: "selectIdentity",
        identityChoices: action.identities,
        teamChoices: [],
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: null,
        pendingPhoneOTPPhone: null,
        phoneAccounts: [],
      };
    case "identitySelectionFailed":
      return {
        ...state,
        route: "selectIdentity",
        isBusy: false,
        errorMessage: action.message,
      };
    case "signedOut":
      return {
        ...state,
        route: "needsAuth",
        teamChoices: [],
        identityChoices: [],
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: null,
        pendingPhoneOTPPhone: null,
        phoneAccounts: [],
        pendingInvites: [],
        currentTeam: null,
        currentMemberActorId: null,
        isAnonymous: false,
      };
  }
}
