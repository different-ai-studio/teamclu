import { clearCachedMqttUrl } from "../../lib/mqtt/config";
import {
  initialOnboardingState,
  onboardingReducer,
} from "./onboarding-reducer";
import type {
  OnboardingAction,
  OnboardingState,
} from "./onboarding-types";
import {
  createRememberedTeamStore,
  type RememberedTeamStore,
} from "./remembered-team";
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
) {
  let state: OnboardingState = initialOnboardingState;
  let activeOperationToken = 0;
  const listeners = new Set<OnboardingListener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (nextState: OnboardingState) => {
    state = nextState;
    notify();
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
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const session = await api.getCurrentSession();
      if (session === null) {
        dispatchIfCurrent(token, { type: "signedOut" });
        return;
      }

      const remembered = await rememberedTeam.load();
      const payload = await api.loadBootstrap(remembered);
      dispatchIfCurrent(token, { type: "bootstrapResolved", payload });
    } catch (error) {
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
      await bootstrap(operationToken);
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
      await bootstrap(operationToken);
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
      await bootstrap(token);
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
    dispatchIfCurrent(token, { type: "signedOut" });
  };

  const resetPendingEmail = () => {
    beginOperation();
    dispatch({ type: "resetPendingEmail" });
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener: OnboardingListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bootstrap,
    selectTeam,
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
  };
}
