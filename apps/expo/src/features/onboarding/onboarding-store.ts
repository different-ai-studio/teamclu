import { clearCachedMqttUrl } from "../../lib/mqtt/config";
import { loadPendingInviteToken } from "./pending-invite";
import { clearComposerDrafts } from "../sessions/composer-drafts";
import { clearReadPositions } from "../sessions/session-read-position";
import {
  initialOnboardingState,
  onboardingReducer,
} from "./onboarding-reducer";
import type {
  MyIdentity,
  OnboardingAction,
  OnboardingState,
} from "./onboarding-types";
import {
  createRememberedTeamStore,
  type RememberedTeamStore,
} from "./remembered-team";
import {
  createLastAppContextStore,
  isNetworkUnreachableError,
  type LastAppContextStore,
} from "./offline-launch";
import {
  createOnboardingIntentStore,
  type OnboardingIntent,
  type OnboardingIntentStore,
} from "./onboarding-intent";
import {
  shouldCompleteOAuthResult,
  type OAuthBrowserResult,
  type OAuthProvider,
} from "./onboarding-oauth";
type OnboardingApi = ReturnType<
  (typeof import("../../lib/supabase/onboarding-api"))["createOnboardingApi"]
>;

type OnboardingListener = () => void;

const SAFE_BOOTSTRAP_ERROR =
  "We couldn't load your account right now. Please try again.";

class BootstrapFailureError extends Error {
  constructor(public readonly cause: unknown) {
    super("Bootstrap failed");
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export function createOnboardingController(
  api: OnboardingApi,
  rememberedTeam: RememberedTeamStore = createRememberedTeamStore(),
  intentStore: OnboardingIntentStore = createOnboardingIntentStore(),
  lastContext: LastAppContextStore = createLastAppContextStore(),
  /** An invite waiting to be claimed must be claimed before a team is chosen. */
  hasPendingInvite: () => Promise<boolean> = async () =>
    (await loadPendingInviteToken().catch(() => null)) !== null,
) {
  let state: OnboardingState = initialOnboardingState;
  let activeOperationToken = 0;
  const listeners = new Set<OnboardingListener>();
  /**
   * True when bootstrap could not reach the server and entered the app on the
   * last team this device was in. Memberships were not checked;
   * `revalidateAfterOfflineLaunch` does that once the network is back.
   */
  let offlineLaunch = false;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (nextState: OnboardingState) => {
    const previous = state;
    state = nextState;
    rememberLastContext(previous, nextState);
    notify();
  };

  /**
   * Keep the offline fallback (iOS #1606) in step with every way of entering a
   * team, and drop it on every way of forgetting one — watched here rather
   * than at each call site, so a new path is covered for free.
   */
  const rememberLastContext = (previous: OnboardingState, next: OnboardingState) => {
    if (next.route === "needsAuth") {
      offlineLaunch = false;
      if (previous.route !== "needsAuth") void lastContext.clear();
      return;
    }
    if (next.route !== "ready" || !next.currentTeam || !next.currentMemberActorId) return;
    if (
      previous.route === "ready" &&
      previous.currentTeam === next.currentTeam &&
      previous.currentMemberActorId === next.currentMemberActorId &&
      previous.isAnonymous === next.isAnonymous
    ) {
      return;
    }
    void lastContext.save({
      team: next.currentTeam,
      memberActorId: next.currentMemberActorId,
      isAnonymous: next.isAnonymous,
    });
  };

  const dispatch = (action: OnboardingAction) => {
    setState(onboardingReducer(state, action));
  };

  const beginOperation = () => {
    activeOperationToken += 1;
    return activeOperationToken;
  };

  const isActiveOperation = (token: number) => token === activeOperationToken;

  const dispatchIfCurrent = (token: number, action: OnboardingAction) => {
    if (isActiveOperation(token)) {
      dispatch(action);
    }
  };

  const finishWithError = (token: number, message: string) => {
    if (!isActiveOperation(token)) {
      return;
    }

    setState({
      ...state,
      isBusy: false,
      errorMessage: message,
    });
  };

  const bootstrap = async (existingToken?: number) => {
    const token = existingToken ?? beginOperation();
    offlineLaunch = false;
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const session = await api.getCurrentSession();
      if (session === null) {
        dispatchIfCurrent(token, { type: "signedOut" });
        return;
      }

      const remembered = await rememberedTeam.load();
      const payload = await api.loadBootstrap(remembered);
      const intent = await intentStore.load();
      if (payload.team !== null && intent !== null) {
        // In a team now: the onboarding choice has done its job (iOS clears it
        // in `setCurrentContext`).
        await intentStore.clear();
      }
      dispatchIfCurrent(token, { type: "bootstrapResolved", payload, intent });
    } catch (error) {
      // No network: open the app on the last team this device was in rather
      // than dead-ending on "Setup failed" (iOS #1606). The local session and
      // the cache hold what the screens show; memberships are rechecked when
      // the network returns. A server that answered with an error still fails.
      if (isActiveOperation(token) && isNetworkUnreachableError(error)) {
        const cached = await lastContext.load();
        if (cached && isActiveOperation(token)) {
          offlineLaunch = true;
          dispatch({
            type: "bootstrapResolved",
            payload: {
              isAnonymous: cached.isAnonymous,
              team: cached.team,
              memberActorId: cached.memberActorId,
              teamChoices: [],
            },
          });
          return;
        }
      }
      dispatchIfCurrent(token, {
        type: "bootstrapFailed",
        message: SAFE_BOOTSTRAP_ERROR,
      });
      if (existingToken === undefined) {
        throw error;
      }
      throw new BootstrapFailureError(error);
    }
  };

  /**
   * App launch (iOS #1709 P5): open straight on the last team instead of
   * waiting for `GET /v1/teams` and the team switch, then check memberships in
   * the background — the same quiet recheck an offline launch gets. Only when
   * nothing has to be decided first: a pending invite, a remembered team that
   * is not the cached one, or a session about to expire all take the full
   * bootstrap.
   */
  const launch = async () => {
    const token = beginOperation();
    try {
      const [session, cached, remembered, pendingInvite] = await Promise.all([
        api.getCurrentSession(),
        lastContext.load(),
        rememberedTeam.load(),
        hasPendingInvite(),
      ]);
      if (
        isActiveOperation(token) &&
        session !== null &&
        hasFreshSession(session) &&
        !pendingInvite &&
        cached !== null &&
        cached.team.id === remembered
      ) {
        offlineLaunch = true;
        dispatch({
          type: "bootstrapResolved",
          payload: {
            isAnonymous: cached.isAnonymous,
            team: cached.team,
            memberActorId: cached.memberActorId,
            teamChoices: [],
          },
        });
        void revalidateAfterOfflineLaunch();
        return;
      }
    } catch {
      // Fall through to the full bootstrap, which reports its own failures.
    }
    if (!isActiveOperation(token)) return;
    await bootstrap(token);
  };

  /**
   * After a sign-in that names a person (email code, password, OAuth): several
   * identities → stop at the org picker and return true; exactly one that is
   * not this account → become it. Best effort, like iOS `offerIdentityChoice`
   * — a failed lookup keeps the signed-in account. Phone sign-in has its own
   * account picker and does not come through here (iOS likewise).
   */
  const offerIdentityChoice = async (token: number): Promise<boolean> => {
    try {
      const identities = await api.listMyIdentities();
      if (!isActiveOperation(token)) return true;
      if (identities.length > 1) {
        dispatch({ type: "identitiesOffered", identities });
        return true;
      }
      const only = identities[0];
      if (identities.length === 1 && only && !only.isCurrent) {
        await api.switchIdentity(only.userId);
      }
    } catch {
      // Keep the signed-in account.
    }
    return false;
  };

  /** Sign-in finished: offer the org picker, else bootstrap. */
  const afterSignIn = async (token: number) => {
    if (await offerIdentityChoice(token)) return;
    await bootstrap(token);
  };

  /**
   * The org picker's choice (iOS `chooseIdentity`): swap to that identity's
   * session unless it is the current one, then the normal team bootstrap. On
   * failure the picker stays up with the error so another can be tried.
   */
  const chooseIdentity = async (identity: MyIdentity) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      if (!identity.isCurrent) {
        await api.switchIdentity(identity.userId);
        // A different account: whatever team the last one remembered is not
        // this identity's choice to inherit.
        await rememberedTeam.clear();
      }
    } catch (error) {
      dispatchIfCurrent(token, {
        type: "identitySelectionFailed",
        message: toErrorMessage(error),
      });
      return;
    }
    try {
      await bootstrap(token);
    } catch {
      // Rendered from controller state (`route: "failed"`).
    }
  };

  const requestOtp = async (email: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const { pendingEmail } = await api.sendEmailOTP(email);
      dispatchIfCurrent(token, { type: "otpRequested", email: pendingEmail });
    } catch (error) {
      finishWithError(token, toErrorMessage(error));
      throw error;
    }
  };

  const verifyOtp = async (token: string) => {
    const email = state.pendingEmailOTPEmail;
    if (!email) {
      throw new Error("No pending email OTP request");
    }

    const operationToken = beginOperation();
    dispatchIfCurrent(operationToken, { type: "beginBusy" });

    try {
      await api.verifyOTP(email, token);
      await afterSignIn(operationToken);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(operationToken, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  /**
   * Email + password sign-in. Unlike the OTP flow there is no pending-email
   * step: one call either produces a session or fails, so it goes straight to
   * bootstrap.
   */
  const signInWithPassword = async (email: string, password: string) => {
    const operationToken = beginOperation();
    dispatchIfCurrent(operationToken, { type: "beginBusy" });

    try {
      await api.signInWithPassword(email.trim(), password);
      await afterSignIn(operationToken);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(operationToken, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  /**
   * Callback URLs already spent, so the one-time PKCE code is exchanged exactly
   * once no matter which channel delivers it. Both can fire for a single
   * sign-in: `openAuthSessionAsync` may resolve with the URL, *and* the OS
   * delivers the same URL to `Linking` because the redirect is a deep link.
   */
  const consumedOAuthCallbacks = new Set<string>();

  /**
   * Exchange an OAuth callback URL for a session, then bootstrap.
   *
   * This is the path that actually carries Google sign-in on Android: the
   * redirect is a deep link, so the OS routes it to the app and the custom tab
   * merely closes — `openAuthSessionAsync` reports `dismiss`, indistinguishable
   * from the user backing out. Driving the exchange off the URL instead means
   * the browser result no longer has to be trusted to carry it.
   *
   * Returns false when the callback was already consumed.
   */
  const completeOAuthFromUrl = async (
    url: string,
    existingToken?: number,
  ): Promise<boolean> => {
    if (consumedOAuthCallbacks.has(url)) return false;
    consumedOAuthCallbacks.add(url);

    const token = existingToken ?? beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      await api.completeOAuthCallback(url);
      await afterSignIn(token);
      return true;
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  const runOAuthBrowserFlow = async (
    token: number,
    authUrl: string,
    redirectTo: string,
    openAuthSession: (
      authUrl: string,
      redirectTo: string,
    ) => Promise<OAuthBrowserResult>,
  ): Promise<boolean> => {
    const result = await openAuthSession(authUrl, redirectTo);
    if (!shouldCompleteOAuthResult(result)) {
      // Not necessarily a cancel — on Android a *successful* redirect also
      // lands here, because the OS consumed the deep link. If the URL already
      // arrived via `Linking`, that completion owns the operation token now,
      // so leave its busy state alone rather than clearing it out from under.
      if (isActiveOperation(token)) {
        setState({
          ...state,
          isBusy: false,
          errorMessage: null,
        });
      }
      return false;
    }
    return completeOAuthFromUrl(result.url!, token);
  };

  const signInWithOAuth = async (
    provider: OAuthProvider,
    {
      redirectTo,
      openAuthSession,
    }: {
      redirectTo: string;
      openAuthSession: (
        authUrl: string,
        redirectTo: string,
      ) => Promise<OAuthBrowserResult>;
    },
  ) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const authUrl = await api.createOAuthSignInUrl(provider, redirectTo);
      // Bootstraps internally on success — the deep-link path has to bootstrap
      // too, so it lives inside `completeOAuthFromUrl` rather than out here.
      await runOAuthBrowserFlow(token, authUrl, redirectTo, openAuthSession);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  const linkIdentityWithOAuth = async (
    provider: OAuthProvider,
    {
      redirectTo,
      openAuthSession,
    }: {
      redirectTo: string;
      openAuthSession: (
        authUrl: string,
        redirectTo: string,
      ) => Promise<OAuthBrowserResult>;
    },
  ) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const authUrl = await api.createOAuthLinkUrl(provider, redirectTo);
      await runOAuthBrowserFlow(token, authUrl, redirectTo, openAuthSession);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  const createTeam = async (name: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      await api.createTeam(name);
      await bootstrap(token);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  /**
   * Adopts one of the offered teams and remembers it, so the picker is asked
   * once rather than on every launch.
   *
   * On failure the route stays on the picker — iOS does the same, so the user
   * can retry or choose a different team rather than being stranded.
   */
  const selectTeam = async (teamId: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      await api.activateTeam(teamId);
      await rememberedTeam.save(teamId);
      await bootstrap(token);
    } catch (error) {
      dispatchIfCurrent(token, {
        type: "teamSelectionFailed",
        message: toErrorMessage(error),
      });
    }
  };

  /**
   * Remember `teamId` and re-bootstrap into it. The bootstrap adopts the
   * remembered team (activating it, which mints a session for its org), so
   * `currentTeam` / `currentMemberActorId` flip together and everything keyed
   * on them — MQTT, the connected-agents store, team caches — rebuilds.
   *
   * A bootstrap failure is not rethrown: it is already in state as
   * `route: "failed"`, whose screen offers retry and sign-out.
   */
  const landOnTeam = async (token: number, teamId: string) => {
    await rememberedTeam.save(teamId);
    try {
      await bootstrap(token);
    } catch {
      // Rendered from controller state.
    }
  };

  /**
   * Settings → Switch Team (iOS `beginTeamSwitch` + `selectTeam`). Unlike the
   * login-time `selectTeam`, a failed activation leaves the current team in
   * place — there is a working context to stay in — and rethrows so the
   * picker can say why.
   */
  const switchTeam = async (teamId: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      await api.activateTeam(teamId);
    } catch (error) {
      if (isActiveOperation(token)) setState({ ...state, isBusy: false });
      throw error;
    }
    await landOnTeam(token, teamId);
  };

  /**
   * Lands on a team the user just joined (an accepted pending invite). The
   * server may mint a session for the joined team's org; adopt it first, as
   * iOS does, then land exactly like a switch.
   */
  const joinedTeam = async (teamId: string, refreshToken: string | null) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      if (refreshToken) await api.adoptRefreshSession(refreshToken);
    } catch (error) {
      if (isActiveOperation(token)) setState({ ...state, isBusy: false });
      throw error;
    }
    await landOnTeam(token, teamId);
  };

  /**
   * Runs `work` as one busy operation that ends in a bootstrap. On failure the
   * route stays where it is with the error shown — the no-team screen and the
   * login screen both rely on that.
   */
  const runThenBootstrap = async (work: () => Promise<void>) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      await work();
      await bootstrap(token);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  // ── Onboarding intent ──────────────────────────────────────────────────

  /** Recorded on the pre-login choice screen; read by every bootstrap. */
  const setIntent = async (intent: OnboardingIntent) => {
    await intentStore.save(intent);
  };

  // ── Phone sign-in ──────────────────────────────────────────────────────

  /**
   * The SMS code, kept for the account picker: a multi-account answer does
   * not consume it, and choosing an account posts it again with `userId`.
   */
  let pendingPhoneCode: string | null = null;

  const requestPhoneOtp = async (phone: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      const { pendingPhone } = await api.sendPhoneOTP(phone);
      pendingPhoneCode = null;
      dispatchIfCurrent(token, { type: "phoneOtpRequested", phone: pendingPhone });
    } catch (error) {
      finishWithError(token, toErrorMessage(error));
      throw error;
    }
  };

  const verifyPhoneOtp = async (code: string) => {
    const phone = state.pendingPhoneOTPPhone;
    if (!phone) {
      throw new Error("No pending phone OTP request");
    }
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });
    try {
      const result = await api.verifyPhoneOTP(phone, code);
      if (result.type === "multiUser") {
        pendingPhoneCode = code;
        dispatchIfCurrent(token, { type: "phoneAccountsOffered", accounts: result.accounts });
        return;
      }
      pendingPhoneCode = null;
      await bootstrap(token);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  /** The user picked one of the accounts the phone maps to. */
  const selectPhoneAccount = async (userId: string) => {
    const phone = state.pendingPhoneOTPPhone;
    const code = pendingPhoneCode;
    if (!phone || !code) {
      throw new Error("No pending phone account choice");
    }
    dispatch({ type: "phoneAccountsDismissed" });
    await runThenBootstrap(async () => {
      await api.loginWithPhoneAccount(phone, code, userId);
      pendingPhoneCode = null;
    });
  };

  const dismissPhoneAccounts = () => {
    dispatch({ type: "phoneAccountsDismissed" });
  };

  const resetPendingPhone = () => {
    beginOperation();
    pendingPhoneCode = null;
    dispatch({ type: "resetPendingPhone" });
  };

  // ── No-team screen ─────────────────────────────────────────────────────

  /** Quiet: an unreachable backend just shows no invites. */
  const refreshPendingInvites = async () => {
    let invites: Awaited<ReturnType<OnboardingApi["listPendingInvites"]>> = [];
    try {
      invites = await api.listPendingInvites();
    } catch {
      invites = [];
    }
    dispatch({ type: "pendingInvitesLoaded", invites });
  };

  /**
   * Refresh button / return to foreground. Re-bootstraps only when a team has
   * appeared, so the screen does not flicker on every check.
   */
  const refreshNoTeam = async () => {
    await refreshPendingInvites();
    let hasTeam = false;
    try {
      hasTeam = await api.hasAnyTeam();
    } catch {
      return;
    }
    if (hasTeam) {
      await bootstrap().catch(() => {});
    }
  };

  /** Joins an invite's team and lands on it. */
  const acceptPendingInvite = async (inviteId: string) => {
    await runThenBootstrap(async () => {
      const teamId = await api.acceptPendingInvite(inviteId);
      dispatch({
        type: "pendingInvitesLoaded",
        invites: state.pendingInvites.filter((invite) => invite.id !== inviteId),
      });
      if (teamId) await rememberedTeam.save(teamId);
    });
  };

  const declinePendingInvite = async (inviteId: string) => {
    try {
      await api.declinePendingInvite(inviteId);
      dispatch({
        type: "pendingInvitesLoaded",
        invites: state.pendingInvites.filter((invite) => invite.id !== inviteId),
      });
    } catch (error) {
      setState({ ...state, errorMessage: toErrorMessage(error) });
      throw error;
    }
  };

  /**
   * Redeem a team join link (#1672), then land on the joined team. Unlike a
   * named invite it claims nothing and does not touch the daemon (iOS
   * `joinByLink`). Rethrows so the paste sheet can stay open with the error.
   */
  const joinByLink = async (linkToken: string, cloudApiUrl: string | null) => {
    await runThenBootstrap(async () => {
      const result = await api.joinByLink(linkToken, cloudApiUrl);
      await rememberedTeam.save(result.teamId);
    });
  };

  /** No-team screen → paste an invite: claim as the signed-in account. */
  const joinWithInvite = async (inviteToken: string) => {
    await runThenBootstrap(async () => {
      const teamId = await api.claimInvite(inviteToken);
      if (teamId) await rememberedTeam.save(teamId);
    });
  };

  /**
   * No-team screen → "start a new team instead": switch the intent and let
   * bootstrap take the create path, exactly as for a user who chose create up
   * front.
   */
  const createTeamFromNoTeam = async () => {
    await intentStore.save("create");
    await bootstrap();
  };

  const signOut = async () => {
    const token = beginOperation();
    await api.signOut();
    // The next user must not inherit this one's team.
    await rememberedTeam.clear();
    // The cached broker was fetched with the outgoing user's token and belongs
    // to their deployment, so it must not survive into the next session. Web
    // clears the same state from its own signOut, via
    // clearBootstrapAppliedFields.
    await clearCachedMqttUrl();
    // Unsent drafts and read positions belong to the account that made them.
    await Promise.all([clearComposerDrafts(), clearReadPositions()]);
    dispatchIfCurrent(token, { type: "signedOut" });
  };

  const resetPendingEmail = () => {
    beginOperation();
    dispatch({ type: "resetPendingEmail" });
  };

  /**
   * After an offline launch, check the team is still one of the user's
   * memberships (iOS `revalidateAfterOfflineLaunch`). Quiet: no splash, and no
   * route change while it still is. Gone (removed while offline) → the
   * bootstrap result lands wherever a fresh launch would. Still offline →
   * stays flagged for the next attempt.
   */
  const revalidateAfterOfflineLaunch = async () => {
    if (!offlineLaunch || state.isBusy || state.route !== "ready") return;
    const token = beginOperation();
    try {
      const session = await api.getCurrentSession();
      if (!isActiveOperation(token)) return;
      if (session === null) {
        offlineLaunch = false;
        dispatch({ type: "signedOut" });
        return;
      }
      const remembered = (await rememberedTeam.load()) ?? state.currentTeam?.id ?? null;
      const payload = await api.loadBootstrap(remembered);
      const intent = await intentStore.load();
      if (!isActiveOperation(token)) return;
      offlineLaunch = false;
      const current = state;
      if (
        payload.team?.id === current.currentTeam?.id &&
        payload.memberActorId === current.currentMemberActorId
      ) {
        // Still a member: only the flag changes.
        notify();
        return;
      }
      dispatch({ type: "bootstrapResolved", payload, intent });
    } catch {
      // Still unreachable, or the server refused: stay on the cached team and
      // try again on the next signal.
    }
  };

  return {
    getState() {
      return state;
    },
    isOfflineLaunch() {
      return offlineLaunch;
    },
    revalidateAfterOfflineLaunch,
    subscribe(listener: OnboardingListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bootstrap,
    launch,
    selectTeam,
    chooseIdentity,
    joinByLink,
    switchTeam,
    joinedTeam,
    requestOtp,
    verifyOtp,
    signInWithPassword,
    signInWithOAuth,
    completeOAuthFromUrl,
    linkIdentityWithOAuth,
    resetPendingEmail,
    createTeam,
    signOut,
    setIntent,
    requestPhoneOtp,
    verifyPhoneOtp,
    selectPhoneAccount,
    dismissPhoneAccounts,
    resetPendingPhone,
    refreshPendingInvites,
    refreshNoTeam,
    acceptPendingInvite,
    declinePendingInvite,
    joinWithInvite,
    createTeamFromNoTeam,
  };
}

/** Two minutes of validity left, so the first requests don't race a refresh. */
const FRESH_SESSION_MARGIN_S = 120;

function hasFreshSession(session: unknown): boolean {
  const expiresAt = (session as { expires_at?: unknown } | null)?.expires_at;
  if (typeof expiresAt !== "number") return false;
  return expiresAt - Date.now() / 1000 >= FRESH_SESSION_MARGIN_S;
}
