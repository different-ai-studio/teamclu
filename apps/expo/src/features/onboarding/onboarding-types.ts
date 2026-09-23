import type { BootstrapTeam } from "./bootstrap-route";
import type { OnboardingIntent } from "./onboarding-intent";
import type { PendingInvite } from "./pending-invites";
import type { PhoneAccount } from "./phone-login";

export type OnboardingRoute =
  | "loading"
  | "needsAuth"
  | "createTeam"
  /**
   * The user is on more than one team and has not chosen. iOS routes here too
   * (`AppOnboardingCoordinator.route == .selectTeam`) rather than adopting one
   * silently — the team decides which org the session is active in, and the
   * wrong one is filtered to empty by RLS.
   */
  | "selectTeam"
  /**
   * Signed in, in no team, and the user said at onboarding they are joining an
   * existing one — so nothing is created for them. iOS `route == .noTeam`.
   */
  | "noTeam"
  | "ready"
  | "failed";

export type TeamSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

export type BootstrapResult = {
  isAnonymous: boolean;
  /** The adopted team, or null when there is nothing to adopt yet. */
  team: TeamSummary | null;
  memberActorId: string | null;
  /**
   * Teams to choose between. Non-empty only when the bootstrap stopped to ask;
   * `team` is null in that case.
   */
  teamChoices: BootstrapTeam[];
};

export type OnboardingState = {
  route: OnboardingRoute;
  /** Populated while `route === "selectTeam"`, empty otherwise. */
  teamChoices: BootstrapTeam[];
  isBusy: boolean;
  errorMessage: string | null;
  pendingEmailOTPEmail: string | null;
  /** Phone a code was sent to; non-null puts the login screen on the code step. */
  pendingPhoneOTPPhone: string | null;
  /**
   * Accounts the phone maps to, when `/v1/auth/phone/login` asked which one.
   * Non-empty shows the account picker.
   */
  phoneAccounts: PhoneAccount[];
  /** Invites addressed to this account; populated on the no-team screen. */
  pendingInvites: PendingInvite[];
  currentTeam: TeamSummary | null;
  currentMemberActorId: string | null;
  isAnonymous: boolean;
};

export type OnboardingAction =
  | {
      type: "beginBusy";
    }
  | {
      type: "clearError";
    }
  | {
      type: "otpRequested";
      email: string;
    }
  | {
      type: "resetPendingEmail";
    }
  | {
      type: "phoneOtpRequested";
      phone: string;
    }
  | {
      type: "resetPendingPhone";
    }
  | {
      /** The phone maps to several accounts — ask which. */
      type: "phoneAccountsOffered";
      accounts: PhoneAccount[];
    }
  | {
      type: "phoneAccountsDismissed";
    }
  | {
      type: "pendingInvitesLoaded";
      invites: PendingInvite[];
    }
  | {
      type: "bootstrapResolved";
      payload: BootstrapResult;
      /** Onboarding intent at the time; `join` + no team → `noTeam`. */
      intent?: OnboardingIntent | null;
    }
  | {
      type: "bootstrapFailed";
      message: string;
    }
  | {
      /** Activation failed — stay on the picker so another team can be tried. */
      type: "teamSelectionFailed";
      message: string;
    }
  | {
      type: "signedOut";
    };
