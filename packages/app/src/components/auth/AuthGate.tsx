import { useEffect, useRef, useState } from "react";
import { useAuthStore, type AuthClaimResult } from "@/stores/auth-store";
import { useCurrentTeamStore, readCachedCurrentTeam } from "@/stores/current-team";
import { getBackend } from "@/lib/backend";
import { isTauri, removeStartupSkeleton } from "@/lib/utils";
import { devSkipDaemonOnboarding, devSkipSetup } from "@/lib/dev-onboarding-flags";
import { resolveDefaultDisplayName } from "@/lib/default-display-name";
import { DesktopOnboarding } from "./DesktopOnboarding";
import { LoginScreen } from "./LoginScreen";
import { isLocaleLocked, availableLanguages } from "@/lib/i18n";
import { LanguageStep } from "@/components/onboarding/LanguageStep";
import { RoleStep } from "@/components/onboarding/RoleStep";
import { SetupStep } from "@/components/onboarding/SetupStep";
import { useOnboardingStore } from "@/stores/onboarding";
import { useSetupStore, setupPreviouslySatisfied } from "@/stores/setup";
import { DaemonOnboardingWizard } from "@/components/auth/DaemonOnboardingWizard";
import { TeamBootstrapErrorScreen } from "@/components/auth/TeamBootstrapErrorScreen";
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";
import { refreshSession } from "@/lib/auth";
import { CloudApiError } from "@/lib/backend/cloud-api/http";
import { humanizeFcError } from "@/lib/fc-error";
import { markStartup } from "@/lib/startup-perf";
import { TeamPicker } from "./TeamPicker";
import { PendingInvitesDialog } from "@/components/auth/PendingInvitesDialog";
import { extensionTeamOnboarding } from "@/lib/build-config";
import { NoTeamScreen } from "./NoTeamScreen";
import type { MembershipTeam } from "@/lib/backend";

/** A one-option "choice" is noise: single-locale builds skip the language step
 *  entirely rather than showing a screen with nothing to decide. */
const canChooseLanguage = !isLocaleLocked && availableLanguages.length > 1;

interface AuthGateProps {
  children: React.ReactNode;
}

type BootstrapState = "idle" | "checking" | "ready" | "no_team" | "error";

function memberTeams(teams: MembershipTeam[]): MembershipTeam[] {
  return teams.filter((team) => team.isMember !== false);
}

/** True when the user must explicitly pick: several teams, or a joinable public one. */
function needsTeamPicker(teams: MembershipTeam[]): boolean {
  return memberTeams(teams).length > 1 || teams.some((team) => team.isMember === false);
}

/**
 * The team to enter without asking. A remembered team OUTRANKS the picker: the
 * user already made that choice on a previous launch, and re-asking every cold
 * start is the bug this ordering fixes.
 *
 * Checking `needsTeamPicker` first (as this did) made the remembered id dead
 * code — anyone with 2+ memberships, or with a single joinable public team in
 * their org (every org has an org-named public default team since #959), got
 * the picker on every launch with "Last used" as a badge and nothing more.
 *
 * The picker therefore only appears when there is no usable history: a genuine
 * first login, or a remembered team the user is no longer a member of.
 * Switching afterwards is Settings → General → switch team.
 */
function pickAutoRestoreTarget(
  teams: MembershipTeam[],
  lastUsedTeamId: string | null,
): MembershipTeam | undefined {
  const members = memberTeams(teams);
  const remembered = lastUsedTeamId
    ? members.find((team) => team.id === lastUsedTeamId)
    : undefined;
  if (remembered) return remembered;
  if (needsTeamPicker(teams)) return undefined;
  return members.length === 1 ? members[0] : undefined;
}

export function AuthGate({ children }: AuthGateProps) {
  const { session, loading, authFlow, hydrate, signOut } = useAuthStore();
  const [bootstrap, setBootstrap] = useState<BootstrapState>("idle");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [checkingNoTeamInvites, setCheckingNoTeamInvites] = useState(false);
  const [authHydrated, setAuthHydrated] = useState(false);
  const bootstrappedUserId = useRef<string | null>(null);
  const savedTeamRestoreUserId = useRef<string | null>(null);

  const setupLoaded = useSetupStore((s) => s.loaded);
  const listSetup = useSetupStore((s) => s.listRequirements);
  // Optimistic skip: if a prior launch confirmed all required deps, don't gate
  // first paint behind the cold `setup_list_requirements` probe (~4s on macOS
  // first launch — it spawns `amuxd doctor`). The probe still runs in the
  // background (effect below) to refresh the cache, and the daemon-onboarding
  // gate is the real backstop if a dependency actually went missing.
  const [setupAck] = useState(() => devSkipSetup() || setupPreviouslySatisfied());

  // First-run onboarding (#881).
  const onboardingLanguageAck = useOnboardingStore((s) => s.languageAck);
  const markOnboardingLanguageAck = useOnboardingStore((s) => s.markLanguageAck);
  const onboardingRole = useOnboardingStore((s) => s.role);
  const onboardingDone = useOnboardingStore((s) => s.completed);
  const setOnboardingRole = useOnboardingStore((s) => s.setRole);
  const markOnboardingCompleted = useOnboardingStore((s) => s.markCompleted);
  // Started-but-unfinished. Whichever screen the user quit on, they come back
  // to it — and it outranks the `setup-ok` optimistic skip below, which would
  // otherwise swallow the rest of a flow the user is visibly in the middle of.
  const onboardingStarted = useOnboardingStore((s) => s.languageAck || s.role !== null);

  const daemonStatus = useDaemonOnboardingStore((s) => s.status);
  const daemonLoaded = useDaemonOnboardingStore((s) => s.loaded);
  // The one remaining question in onboarding: name a brand-new agent for this
  // machine. It must hold the gate, or the shell would render behind the prompt.
  const daemonAwaitingName = useDaemonOnboardingStore((s) => !!s.pendingName);
  const refreshDaemonOnboarding = useDaemonOnboardingStore((s) => s.refresh);
  const [daemonOnboardingAck, setDaemonOnboardingAck] = useState(() => devSkipDaemonOnboarding());

  // Multi-team (cross-org) picker. Match iOS onboarding: restore the last team
  // the user entered when it is still a membership, activate it to mint an
  // org-scoped JWT, and only ask on a first multi-team login.
  const [myTeams, setMyTeams] = useState<MembershipTeam[] | null>(null);
  const [teamChosen, setTeamChosen] = useState(false);
  const [teamChoiceResolved, setTeamChoiceResolved] = useState(false);
  // The team this user last entered (persisted from a prior session). Captured
  // before team-bootstrap can overwrite the cache, so the picker can badge it
  // "Last used". Null on a genuinely-first login (no history).
  const [lastUsedTeamId, setLastUsedTeamId] = useState<string | null>(null);
  // Team discovery must not race a link invite claim. The claim enters the
  // invited team and clears the token asynchronously; keeping the promise in
  // a ref lets the bootstrap effect await the exact in-flight operation even
  // when React re-runs effects in StrictMode.
  const inviteClaimPromise = useRef<Promise<AuthClaimResult | null> | null>(null);

  useEffect(() => {
    if (isTauri()) void listSetup();
  }, [listSetup]);

  // Re-evaluate the picker on every login: clear the pick flag + cached list
  // whenever the signed-in user changes.
  useEffect(() => {
    setTeamChosen(false);
    setTeamChoiceResolved(false);
    savedTeamRestoreUserId.current = null;
    setMyTeams(null);
    // Capture the genuine last-used team (persisted by a prior session) NOW,
    // before the team-bootstrap effect below adopts a team and overwrites the
    // cache. Guard on teamUserId so one user's cache never leaks into another's.
    const cached = readCachedCurrentTeam();
    setLastUsedTeamId(
      cached && cached.teamUserId === session?.user?.id ? cached.team?.id ?? null : null,
    );
  }, [session?.user?.id]);

  // After login + team-bootstrap ready, refresh the discoverable selection
  // source. Bootstrap normally supplies it already; this also catches an
  // invite claim that completed while the gate was resolving.
  useEffect(() => {
    if (!session || bootstrap !== "ready" || teamChosen) return;
    let cancelled = false;
    void (async () => {
      try {
        const teams = await getBackend().teams.listAllMyTeams();
        if (!cancelled) setMyTeams(teams);
      } catch (e) {
        console.warn("[AuthGate] listAllMyTeams failed", e);
        if (!cancelled) setMyTeams([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, bootstrap, teamChosen]);

  // iOS persists `activeTeamID` and explicitly activates it at the next
  // bootstrap. Do the same on every client (desktop + extension/web): the
  // refresh token returned by activate carries the selected org, so merely
  // restoring a local cache is not enough.
  useEffect(() => {
    if (!session || bootstrap !== "ready" || myTeams === null || teamChoiceResolved) {
      return;
    }

    const target = pickAutoRestoreTarget(myTeams, lastUsedTeamId);
    if (!target) {
      setTeamChoiceResolved(true);
      return;
    }
    if (savedTeamRestoreUserId.current === session.user.id) return;
    savedTeamRestoreUserId.current = session.user.id;

    const userId = session.user.id;
    void (async () => {
      try {
        await useCurrentTeamStore.getState().switchToTeam(target.id);
        if (useAuthStore.getState().session?.user.id === userId) setTeamChosen(true);
      } catch (error) {
        // Keep the picker available if the remembered team was removed or the
        // activation request failed; this matches iOS falling back to selection.
        console.warn("[AuthGate] saved-team activation failed", error);
      } finally {
        if (useAuthStore.getState().session?.user.id === userId) setTeamChoiceResolved(true);
      }
    })();
  }, [session, bootstrap, myTeams, lastUsedTeamId, teamChoiceResolved]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(hydrate()).finally(() => {
      if (!cancelled) setAuthHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    markStartup("authgate:mount");
  }, []);

  useEffect(() => {
    if (isTauri() && session && bootstrap === "ready") void refreshDaemonOnboarding()
  }, [session, bootstrap, refreshDaemonOnboarding]);

  // Claim a stashed invite once the user signs in with a REAL (non-anonymous)
  // account. Member invites can't be claimed anonymously (enforced server-side
  // in claim_team_invite), so the onboarding stashes the token and routes the
  // user through sign-in; this completes the join afterward.
  const pendingInviteToken = useAuthStore((s) => s.pendingInviteToken);
  // Which token this mount has already run a claim for. Team bootstrap defers
  // to a pending claim (below), so without this a claim that fails and leaves
  // the token in place would block bootstrap forever and the gate would render
  // nothing. Attempted-once is the condition to stop waiting on — not
  // claimed-successfully.
  const inviteClaimAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    if (!pendingInviteToken) return;
    if (inviteClaimAttempted.current === pendingInviteToken) return;
    inviteClaimAttempted.current = pendingInviteToken;
    const claimPromise = useAuthStore.getState().claimPendingInvite();
    inviteClaimPromise.current = claimPromise;
    void claimPromise
      .then((result) => {
        // A claimed invite is an explicit team choice; don't immediately reopen
        // the general picker after its active-team switch completes.
        if (result) setTeamChosen(true);
      })
      .catch((error) => {
        console.warn("[AuthGate] pending invite claim failed", error);
      })
      .finally(() => {
        if (inviteClaimPromise.current === claimPromise) inviteClaimPromise.current = null;
      });
  }, [session, pendingInviteToken]);

  // Separate from the token replay above: these invites were addressed to the
  // user's verified email/phone and matched server-side, so the user never had
  // a link. Skipped while a token claim is queued — that invite is the one the
  // user actually acted on, and joining it may satisfy the pending list anyway.
  useEffect(() => {
    if (!session) return;
    if (pendingInviteToken) return;
    // A caller with no team blocks on the server's answer first (403 →
    // "no_team"), and the no-team screen runs this lookup itself. Existing-team
    // users refresh once bootstrap reaches ready so the in-app dialog works.
    void useAuthStore.getState().refreshPendingInvites();
  }, [session, pendingInviteToken]);

  // After auth, resolve the full team chooser before entering a team. Only an
  // empty result may create a team; it uses the dedicated atomic bootstrap RPC.
  //
  // The ref guard (instead of a cleanup-driven `cancelled` flag) is
  // deliberate: under React strict mode the effect runs twice, and a
  // cancelled-flag pattern would mark the in-flight request as discarded
  // and leave bootstrap pinned at "checking" forever.
  useEffect(() => {
    if (loading) return;
    if (!session) {
      bootstrappedUserId.current = null;
      setBootstrap("idle");
      setBootstrapError(null);
      setRetrying(false);
      return;
    }
    // An invite claim has precedence over normal discovery. claimPendingInvite
    // enters the invited team and clears this token on success. Only wait while
    // the claim is still unattempted: a failed claim keeps its token for a
    // later retry, and waiting on that pinned `bootstrap` at "idle" — every
    // gate below then rendered null, i.e. a white screen with no way out.
    if (pendingInviteToken && inviteClaimAttempted.current !== pendingInviteToken) return;
    // Browser runtime (Chrome extension / web build) is a real cloud client:
    // it still needs a current team for MQTT + team-scoped reads, so it must
    // run the same team-bootstrap as desktop. The bootstrap path below is
    // browser-safe (Cloud API + try/catch-guarded local cache). Only the
    // desktop-specific setup/daemon gates remain isTauri()-fenced (below).
    if (bootstrappedUserId.current === session.user.id) return;
    bootstrappedUserId.current = session.user.id;
    markStartup("team-bootstrap:start");

    setBootstrap("checking");

    void (async () => {
      let teamSet = false;
      let bootErr: unknown = null;
      try {
        const pendingClaim = pendingInviteToken ? inviteClaimPromise.current : null;
        if (pendingClaim) {
          const claimed = await pendingClaim;
          if (claimed) {
            // The claim already entered the invited team. Mark bootstrap ready
            // explicitly so a concurrently started team-list request cannot
            // overwrite the successful onboarding with `no_team`.
            setMyTeams([]);
            setTeamChosen(true);
            setBootstrapError(null);
            setRetrying(false);
            markStartup("team-bootstrap:end");
            setBootstrap("ready");
            return;
          }
        }
        const allTeams = await getBackend().teams.listAllMyTeams();
        markStartup("team-list:end");
        if (allTeams.length > 0) {
          // Do not auto-select the first row: the chooser makes the org then
          // team decision explicit, including public teams that need joining.
          setMyTeams(allTeams);
          teamSet = true;
        } else {
          // Login onboarding. The server resolves the org — minting one named
          // after the caller when they have none — and returns that org's
          // public default team, creating it on first use.
          //
          // `displayName` seeds the OWNER ACTOR only, never the org or team
          // name: it resolves OS-account-name first, which on a fleet-imaged
          // machine is the IT admin. The server names the org from the account
          // (nickname → OAuth full name → email local part).
          const displayName = await resolveDefaultDisplayName(session?.user?.email);
          const created = await getBackend().teams.bootstrapTeam({ displayName });
          if (created?.id) {
            await useCurrentTeamStore.getState().setActiveTeam({
              id: created.id,
              name: created.name,
              slug: created.slug ?? "",
            });
            // The bootstrap response is the only possible team by definition,
            // so it is already an explicit onboarding outcome.
            setTeamChosen(true);
            teamSet = true;
            console.log("[AuthGate] auto-created team", created.name);
          } else {
            bootErr = new Error("bootstrap returned no team id");
          }
        }
      } catch (err) {
        // The deployment has self-registration off and this caller has no org
        // to fall back on. Not an error state: it is the waiting-for-invite
        // state, and the screen below offers exactly the two ways out (accept a
        // pending invite, or sign in as someone else).
        if (err instanceof CloudApiError && err.status === 403) {
          setMyTeams([]);
          await useAuthStore.getState().refreshPendingInvites();
          markStartup("team-bootstrap:end");
          setRetrying(false);
          setBootstrapError(null);
          setBootstrap("no_team");
          return;
        }
        if (err instanceof CloudApiError && err.status === 401) {
          try {
            await refreshSession();
            bootstrappedUserId.current = null;
            setBootstrapNonce((n) => n + 1);
            setRetrying(false);
            return;
          } catch (refreshErr) {
            console.warn("[AuthGate] auth rejected, signing out", refreshErr);
            await signOut();
            return;
          }
        }
        bootErr = err;
        console.warn("[AuthGate] team bootstrap failed", err);
      }
      markStartup("team-bootstrap:end");
      setRetrying(false);
      if (teamSet) {
        setBootstrapError(null);
        setBootstrap("ready");
      } else {
        // No current team means the app can't continue — daemon onboarding,
        // sessions and the actor directory are all team-scoped. Surface the
        // failure with a retry instead of silently dropping into an empty,
        // half-broken shell (the previous behavior swallowed this error).
        setBootstrapError(humanizeFcError(bootErr));
        setBootstrap("error");
      }
    })();
  }, [loading, session, bootstrapNonce, pendingInviteToken, signOut]);

  const retryBootstrap = () => {
    // Re-arm the per-user ref guard and bump the nonce so the bootstrap effect
    // runs again. `retrying` keeps the error screen up (with a spinner) instead
    // of flashing back to the skeleton while the retry is in flight.
    bootstrappedUserId.current = null;
    setRetrying(true);
    setBootstrapNonce((n) => n + 1);
  };

  const retryNoTeamInvites = () => {
    if (checkingNoTeamInvites) return;
    setCheckingNoTeamInvites(true);
    void useAuthStore.getState().refreshPendingInvites().finally(() => {
      setCheckingNoTeamInvites(false);
    });
  };

  const finishPendingInvite = () => {
    setTeamChosen(true);
    setTeamChoiceResolved(true);
    setBootstrapError(null);
    setBootstrap("ready");
  };

  // Each gate below either (a) is a pure-loading state — return null so the
  // static #skeleton (z-9999, mirrors the real shell) keeps showing through an
  // empty #root, no blank flash; or (b) renders real/interactive UI — tear the
  // skeleton down first so the screen is visible and clickable.
  //
  // Desktop happy path: children deliberately do NOT remove the skeleton —
  // App removes it once the workspace resolves (skeleton → real UI).
  // Extension/web: there is no workspace gate, so AuthGate removes the
  // skeleton when rendering children. If App tore it down earlier, #root
  // would stay empty through auth hydrate / team bootstrap / myTeams and
  // the side panel would flash white for seconds.

  // First-run onboarding (#881), ahead of auth: pick a setup style, then get the
  // runtime and local dependencies in place. Models are not asked for here —
  // they are configured in Settings once the app is up.
  //
  // Returning users skip all of it: `onboardingDone` is set once the flow
  // completes, and `setupAck` (the setup-ok cache) covers installs that
  // predate it.
  if (isTauri() && !onboardingDone && (!setupAck || onboardingStarted)) {
    if (!setupLoaded) {
      return null;
    }
    // Language first, alone. Everything below it is written in whichever
    // language this answers, so it cannot share a screen with them. Skipped
    // outright on single-locale builds, where there is nothing to ask.
    if (!onboardingLanguageAck && canChooseLanguage) {
      removeStartupSkeleton();
      return <LanguageStep onDone={markOnboardingLanguageAck} />;
    }
    if (!onboardingRole) {
      removeStartupSkeleton();
      return <RoleStep onDone={setOnboardingRole} />;
    }
    removeStartupSkeleton();
    return <SetupStep role={onboardingRole} onDone={markOnboardingCompleted} />;
  }

  if (isTauri() && loading && authFlow === "invite") {
    removeStartupSkeleton();
    return <DesktopOnboarding />;
  }

  // Decide nothing until the initial session restore has settled. This is
  // deliberately `authHydrated` alone, NOT `authHydrated && loading` and not
  // `loading` on its own:
  //
  //  - as a conjunction it stopped guarding as soon as EITHER signal cleared,
  //    so a hydrate that resolved without applying a session fell straight
  //    through to the login branch below (cold-start login flash);
  //  - `loading` cannot be used here because every auth action shares it
  //    (sendOtp, verifyOtp, OAuth, WebSSO, invite…). Gating on it would blank
  //    the login screen the moment a signed-out user submits their code.
  //
  // `hydrate` now catches its own failures and always resolves to a defined
  // state, so this flag means exactly "startup auth is settled" — whether it
  // settled on a session or on none. It is still set from `.finally()` on
  // purpose: an unblocked gate showing the login screen beats a gate that never
  // unblocks and leaves the startup skeleton up forever.
  if (!authHydrated) {
    return null;
  }

  if (!session) {
    removeStartupSkeleton();
    return isTauri() ? <DesktopOnboarding /> : <LoginScreen />;
  }

  if (loading) {
    return null;
  }

  // Team bootstrap failed (e.g. createTeam rejected by a drifted backend).
  // Surface it with a retry; `retrying` keeps this up while a retry re-resolves.
  // Applies on extension/web too — team-scoped UI cannot run without a team.
  if (bootstrap === "error" || retrying) {
    removeStartupSkeleton();
    return (
      <TeamBootstrapErrorScreen
        error={bootstrapError}
        busy={retrying}
        onRetry={retryBootstrap}
        onSignOut={() => void signOut()}
      />
    );
  }

  if (bootstrap === "no_team") {
    removeStartupSkeleton();
    return (
      <>
        <NoTeamScreen
          messages={extensionTeamOnboarding.noTeamMessage}
          checking={checkingNoTeamInvites}
          onRetry={retryNoTeamInvites}
          onSignOut={() => void signOut()}
        />
        <PendingInvitesDialog onAccepted={finishPendingInvite} />
      </>
    );
  }

  // Hold the skeleton through team bootstrap on every platform. Extension/web
  // used to fall through here and paint children, then bounce back to null
  // while myTeams loaded — a white flash once the skeleton was already gone.
  if (bootstrap !== "ready") {
    return null;
  }

  // Wait for the saved-team restoration decision before rendering the picker
  // or shell (desktop and extension/web alike).
  if (!teamChosen && !teamChoiceResolved) {
    return null;
  }

  // Multi-team picker gate: after team-bootstrap, before the daemon gate. If the
  // user belongs to 2+ teams (possibly across orgs) and hasn't picked this
  // session yet, choose a team first. Selecting calls switchToTeam (activates
  // the team server-side, adopts the org-switched JWT, switches current team,
  // and refreshes the daemon) — so the daemon gate below then evaluates against
  // the chosen team and triggers re-onboard on mismatch.
  if (session && !teamChosen) {
    if (myTeams === null) {
      return null; // Still loading the team list — keep the skeleton.
    }
    if (needsTeamPicker(myTeams)) {
      removeStartupSkeleton();
      return (
        <TeamPicker
          teams={myTeams}
          lastUsedTeamId={lastUsedTeamId}
          onDone={() => setTeamChosen(true)}
        />
      );
    }
  }

  // Daemon readiness gate: after login + workspace bootstrap, ensure the local
  // daemon is bound to this machine's agent in the current team AND running with a
  // valid token. None of these states prompt for input any more — needs-onboard
  // and mismatch are resolved by binding (team, device id) server-side, and the
  // screen below is progress plus a retry on failure. 'ready'/'unknown' fall
  // through.
  if (isTauri() && !daemonOnboardingAck) {
    if (!daemonLoaded) {
      return null;
    }
    if (
      daemonAwaitingName ||
      daemonStatus === 'needs-onboard' ||
      daemonStatus === 'mismatch' ||
      daemonStatus === 'starting' ||
      daemonStatus === 'error'
    ) {
      removeStartupSkeleton();
      return <DaemonOnboardingWizard onDone={() => setDaemonOnboardingAck(true)} />;
    }
  }

  markStartup("authgate:children");
  if (!isTauri()) {
    removeStartupSkeleton();
  }
  // Rendered alongside the app rather than as a gate: an unaccepted invite is
  // not a reason to withhold the workspace the user already has.
  return (
    <>
      {children}
      <PendingInvitesDialog />
    </>
  );
}
