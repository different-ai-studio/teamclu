import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Link2, RotateCcw, Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { probeCloudApi } from "@/lib/config/bootstrap";
import { parseInviteInput } from "@/lib/team/invite-deeplink";
import { confirmInviteLinkToken } from "@/lib/team/invite-link-confirmation";
import {
  displayHost,
  getCloudApiUrlOverride,
  getDefaultCloudApiUrl,
  getEffectiveServerConfigSync,
  normalizeCloudApiUrl,
  setCloudApiUrlOverride,
} from "@/lib/config/server-config";
import { useAppVersion } from "@/lib/config/version";
import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/stores/onboarding";
import { useUpdaterStore } from "@/stores/updater";
import { LoginScreen } from "./LoginScreen";
import { useShallow } from "zustand/react/shallow";

/**
 * First-run setup, as a straight line: invite link → server → sign in.
 *
 * It replaced a three-way menu (sign in / join a team / custom server) that
 * asked the user to classify themselves before they had been told what the
 * options meant. The line asks one answerable question at a time, and the first
 * one — "do you have an invite link?" — answers the second for most people,
 * because the link names the server it belongs to.
 */
type Step = "invite" | "server" | "login";

/** Where the server address came from, once the wizard has settled it. */
type ServerOutcome = "invite" | "official" | "custom";

/**
 * The version line, which doubles as the way to update from here.
 *
 * Being able to update while signed out is the point: the updater used to be
 * mounted inside `App`, so it only ever ran for someone who had already got
 * past this screen — and a release that strands people here is exactly the one
 * they need to leave.
 */
function VersionFooter() {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const { state, progress, checkForUpdates } = useUpdaterStore(
    useShallow((s) => ({
      state: s.update.state,
      progress: s.update.progress,
      checkForUpdates: s.checkForUpdates,
    })),
  );

  const status = () => {
    switch (state) {
      case "checking":
        return t("updater.checking", "Checking for updates…");
      case "downloading":
        return t("updater.downloading", "Downloading {{percent}}%", {
          percent: Math.round(progress ?? 0),
        });
      case "ready":
        return t("updater.restartToUpdate", "Restart to update");
      case "up-to-date":
        return t("updater.upToDate", "Up to date");
      // `error` reaches the dialog, which says more than a footer can. A silent
      // check never lands here — it resets to idle — so this is only ever the
      // result of a click.
      case "error":
        return t("updater.checkFailed", "Update check failed");
      default:
        return t("updater.check", "Check for updates");
    }
  };

  const busy = state === "checking" || state === "downloading";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void checkForUpdates()}
      className="mt-6 self-center rounded-[6px] px-2 py-1 font-mono text-[11px] text-faint transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-faint"
    >
      v{appVersion} · {status()}
    </button>
  );
}

/**
 * Look for an update once per app run, while the user is still signed out.
 *
 * Deliberately NOT gated on the Settings → General opt-in the background
 * checker honours. That preference keeps a working install from downloading
 * things unasked; this call is for the install that cannot get past this
 * screen, where updating is the only way out. It costs one request for the
 * release manifest, and anything it finds still ends at a dismissable
 * "restart to apply" prompt.
 *
 * Runs at most once per mount of the wizard, and never on top of a check that
 * is already in flight or has already found something — `checkForUpdates`
 * restarts the download from scratch.
 */
function useOnboardingUpdateCheck() {
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const updater = useUpdaterStore.getState();
    if (updater.update.state !== "idle") return;
    void updater.checkForUpdates(true);
  }, []);
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl;
  const override = getCloudApiUrlOverride();
  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground">
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">
        {children}
        <VersionFooter />
        {/* An absent URL used to render nothing at all, so a build with no
            backend baked in looked exactly like a working one. */}
        <p
          className={[
            "mt-0.5 text-center font-mono text-[10px]",
            override ? "text-coral" : "text-faint/70",
          ].join(" ")}
        >
          {cloudApiUrl ? (
            <>
              {displayHost(cloudApiUrl)}
              {override && ` · ${t("auth.onboarding.serverCustomTag", "custom")}`}
            </>
          ) : (
            t("auth.onboarding.serverUnset", "no server configured")
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Re-run the wizard from the top — the language step included; the runtime
 * install lives in the post-login daemon wizard and re-checks itself every
 * launch.
 *
 * Reload rather than flipping state in place: half the wizard's inputs (the
 * daemon store) were seeded on the way here, and a reload re-derives all of it,
 * which is what makes the re-run identical to a first run.
 */
function rerunSetup() {
  useOnboardingStore.getState().reset();
  window.location.reload();
}

function RerunButton() {
  const { t } = useTranslation();
  return (
    // Sits inside the drag strip, opposite the traffic lights. Painted after
    // the drag region, so it stays clickable.
    <button
      type="button"
      onClick={rerunSetup}
      className="absolute right-6 top-6 inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] text-faint transition-colors hover:bg-panel hover:text-foreground"
    >
      <RotateCcw className="h-3.5 w-3.5" />
      {t("auth.onboarding.rerunSetup", "Run setup again")}
    </button>
  );
}

function StepFrame({
  children,
  onBack,
  rerun,
}: {
  children: React.ReactNode;
  onBack?: () => void;
  rerun?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Shell>
      {rerun && <RerunButton />}
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="mb-5 inline-flex w-fit items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("onboarding.common.back", "Back")}
          </button>
        ) : (
          // Reserve the row so the card does not jump between steps.
          <div className="mb-5 h-[26px]" />
        )}
        {children}
      </div>
    </Shell>
  );
}

function ChoiceRow({
  icon,
  title,
  caption,
  primary,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  caption: React.ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[14px] border border-border bg-paper p-3 text-left transition-colors hover:bg-selected/45"
    >
      <span
        className={[
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
          primary ? "bg-coral text-coral-foreground" : "bg-panel text-ink-2",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
    </button>
  );
}

/**
 * Applies a server address without reloading the window.
 *
 * The reload the "custom server" screen used to do exists to throw away a
 * session issued by the previous backend — and this wizard only ever runs while
 * signed out (`AuthGate` renders it under `!session`). Reloading here would
 * also undo the wizard itself: React state is lost, the flow restarts at step
 * one, and the invite confirmation — deliberately per-run, see
 * `invite-link-confirmation.ts` — is gone, so a token the user just typed gets
 * a "join this team?" dialog after sign-in.
 *
 * Nothing else is stale afterwards: `getBackend()` caches by
 * `cloud_api:<url>`, remote features listen for the change event, and every
 * other reader resolves the config at call time.
 */
function applyServerUrl(url: string | null): boolean {
  try {
    setCloudApiUrlOverride(url);
    return true;
  } catch {
    return false;
  }
}

/** Shared probe + apply, used by both the invite and the custom-server steps. */
function useServerProbe() {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a probe has failed, so the user can override a verdict that may be
  // wrong for their situation — a server that is not up yet, or one only
  // reachable from a network they are not on right now.
  const [allowUnverified, setAllowUnverified] = useState(false);

  const reset = () => {
    setError(null);
    setAllowUnverified(false);
  };

  /** Returns true when the address was verified and applied. */
  const verifyAndApply = async (raw: string): Promise<boolean> => {
    setError(null);
    // Shape first. A scheme-less `api.mycorp.com` is fetched as a URL relative
    // to tauri://localhost, fails, and comes back as "could not reach that
    // address" — sending the user off to check a server that was never asked.
    if (!normalizeCloudApiUrl(raw)) {
      setError(
        t("auth.onboarding.serverUrlInvalid", "Enter a valid http(s) URL, e.g. https://api.example.com"),
      );
      return false;
    }
    setChecking(true);
    try {
      const probe = await probeCloudApi(raw);
      if (!probe.ok) {
        setAllowUnverified(true);
        setError(
          probe.reason === "unreachable"
            ? t(
                "auth.onboarding.serverUnreachable",
                "Could not reach that address. Check the URL and that the server is running.",
              )
            : t(
                "auth.onboarding.serverNotCloudApi",
                "That address answered, but it is not a TeamClu Cloud API ({{status}}).",
                { status: probe.status ?? "?" },
              ),
        );
        return false;
      }
    } finally {
      setChecking(false);
    }
    if (!applyServerUrl(raw)) {
      setError(
        t("auth.onboarding.serverUrlInvalid", "Enter a valid http(s) URL, e.g. https://api.example.com"),
      );
      return false;
    }
    return true;
  };

  return { checking, error, setError, allowUnverified, reset, verifyAndApply };
}

/**
 * Step 1: the invite link, or an explicit "I don't have one".
 *
 * A link carries the inviter's Cloud API address, so answering yes settles the
 * server question too and the next screen is sign-in. Answering no falls
 * through to picking a server by hand.
 */
function InviteStep({
  onSkip,
  onNeedServer,
  onDone,
}: {
  onSkip: () => void;
  onNeedServer: (token: string) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const setPendingInviteToken = useAuthStore((s) => s.setPendingInviteToken);
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const probe = useServerProbe();

  /** Stash the token for the claim that runs right after sign-in. */
  const acceptToken = (token: string) => {
    setPendingInviteToken(token);
    // The user typed this token themselves; skip the deep-link confirmation.
    confirmInviteLinkToken(token);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setParseError(null);
    probe.reset();
    const parsed = parseInviteInput(raw);
    if (!parsed) {
      setParseError(
        t("auth.onboarding.inviteParseError", "Enter a valid invite token or invite link."),
      );
      return;
    }
    if (parsed.cloudApiUrl) {
      if (!(await probe.verifyAndApply(parsed.cloudApiUrl))) return;
      acceptToken(parsed.token);
      onDone();
      return;
    }
    // A bare token names no server. Use the one already in effect; with no
    // effective address at all there is nothing to claim it against, so ask.
    acceptToken(parsed.token);
    if (getEffectiveServerConfigSync().cloudApiUrl) onDone();
    else onNeedServer(parsed.token);
  };

  const continueUnverified = () => {
    const parsed = parseInviteInput(raw);
    if (!parsed?.cloudApiUrl || !applyServerUrl(parsed.cloudApiUrl)) return;
    acceptToken(parsed.token);
    onDone();
  };

  return (
    <StepFrame rerun>
      <form onSubmit={submit} className="rounded-[16px] border border-border bg-paper p-5">
        <h1 className="text-[18px] font-semibold">
          {t("auth.onboarding.inviteQuestion", "Do you have an invite link?")}
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t(
            "auth.onboarding.inviteQuestionDesc",
            "Paste it here and everything else is set up for you — including which server to sign in to. The invite is claimed right after you sign in.",
          )}
        </p>
        <label className="mt-5 block space-y-2">
          <span className="text-[12px] font-medium text-ink-2">
            {t("auth.onboarding.inviteLabel", "Invite link or token")}
          </span>
          <Input
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              setParseError(null);
              // A different link has not been rejected yet, so it does not
              // inherit the previous one's "continue anyway".
              probe.reset();
            }}
            spellCheck={false}
            autoCapitalize="none"
            className="h-10 font-mono text-[12px]"
          />
        </label>
        {(parseError || probe.error) && (
          <p className="mt-3 text-[12px] text-destructive">{parseError || probe.error}</p>
        )}
        <Button
          type="submit"
          disabled={probe.checking || !raw.trim()}
          className="mt-5 h-10 w-full bg-coral text-coral-foreground"
        >
          {probe.checking
            ? t("auth.onboarding.serverChecking", "Checking…")
            : t("onboarding.common.next", "Next")}
        </Button>
        {probe.allowUnverified && !probe.checking && (
          <button
            type="button"
            onClick={continueUnverified}
            className="mt-3 w-full rounded-[6px] py-1 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t("auth.onboarding.inviteContinueAnyway", "Continue anyway")}
          </button>
        )}
      </form>
      <button
        type="button"
        onClick={onSkip}
        className="mt-4 w-full rounded-[8px] py-2 text-[13px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        {t("auth.onboarding.inviteNone", "I don't have an invite link")}
      </button>
    </StepFrame>
  );
}

/**
 * Step 2: which server. Only reached when no invite link named one.
 *
 * A build with nothing baked in has no official server to offer, so the choice
 * collapses to the custom form rather than showing an entry that cannot work.
 */
function ServerStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const defaultUrl = getDefaultCloudApiUrl();
  const [custom, setCustom] = useState(!defaultUrl);
  const [raw, setRaw] = useState(getCloudApiUrlOverride() ?? defaultUrl ?? "");
  const probe = useServerProbe();

  const chooseOfficial = () => {
    applyServerUrl(null);
    onDone();
  };

  const submitCustom = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await probe.verifyAndApply(raw)) onDone();
  };

  if (!custom) {
    return (
      <StepFrame onBack={onBack} rerun>
        <div className="mb-5">
          <h1 className="text-[18px] font-semibold">
            {t("auth.onboarding.serverChoiceTitle", "Which server do you sign in to?")}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            {t(
              "auth.onboarding.serverChoiceDesc",
              "Use the official server, or point the app at your company's own deployment.",
            )}
          </p>
        </div>
        <div className="space-y-3">
          <ChoiceRow
            primary
            icon={<Server className="h-4 w-4" />}
            title={t("auth.onboarding.serverOfficial", "Official server")}
            caption={
              <span className="block truncate font-mono text-[11.5px] text-ink-2">
                {displayHost(defaultUrl as string)}
              </span>
            }
            onClick={chooseOfficial}
          />
          <ChoiceRow
            icon={<Link2 className="h-4 w-4" />}
            title={t("auth.onboarding.serverCustom", "Custom server")}
            caption={t(
              "auth.onboarding.serverCustomDesc",
              "Enter the Cloud API address of your company's own deployment.",
            )}
            onClick={() => setCustom(true)}
          />
        </div>
      </StepFrame>
    );
  }

  return (
    <StepFrame onBack={defaultUrl ? () => setCustom(false) : onBack} rerun>
      <form onSubmit={submitCustom} className="rounded-[16px] border border-border bg-paper p-5">
        <h1 className="text-[18px] font-semibold">
          {t("auth.onboarding.serverCustom", "Custom server")}
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t(
            "auth.onboarding.serverCustomFormDesc",
            "Enter the Cloud API address of your company's own deployment. You sign in against that server.",
          )}
        </p>
        {!defaultUrl && (
          <div className="mt-4 flex items-start gap-2 rounded-[12px] border border-border bg-panel px-3.5 py-3 text-[12px] leading-5 text-ink-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-coral" />
            <span>
              {t(
                "auth.onboarding.noServerNotice",
                "This build ships no server address, so there is nothing to fall back to — signing in needs one.",
              )}
            </span>
          </div>
        )}
        <label className="mt-5 block space-y-2">
          <span className="text-[12px] font-medium text-ink-2">
            {t("auth.onboarding.serverUrlLabel", "Cloud API URL")}
          </span>
          <Input
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              probe.reset();
            }}
            placeholder="https://api.example.com"
            spellCheck={false}
            autoCapitalize="none"
            className="h-10 font-mono text-[12px]"
          />
        </label>
        {probe.error && <p className="mt-3 text-[12px] text-destructive">{probe.error}</p>}
        <Button
          type="submit"
          disabled={probe.checking || !raw.trim()}
          className="mt-5 h-10 w-full bg-coral text-coral-foreground"
        >
          {probe.checking
            ? t("auth.onboarding.serverChecking", "Checking…")
            : t("onboarding.common.next", "Next")}
        </Button>
        {probe.allowUnverified && !probe.checking && (
          <button
            type="button"
            onClick={() => {
              if (applyServerUrl(raw)) onDone();
            }}
            className="mt-3 w-full rounded-[6px] py-1 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t("auth.onboarding.serverSaveAnyway", "Save it anyway")}
          </button>
        )}
      </form>
    </StepFrame>
  );
}

export function DesktopOnboarding() {
  useOnboardingUpdateCheck();
  const { serverAck, markServerAck } = useOnboardingStore(
    useShallow((s) => ({ serverAck: s.serverAck, markServerAck: s.markServerAck })),
  );
  // Someone who has been through this once — and anyone arriving on an
  // OS-delivered invite link, whose token is already stashed — is past the
  // questions and only has to sign in.
  const [step, setStep] = useState<Step>(() =>
    serverAck || useAuthStore.getState().pendingInviteToken ? "login" : "invite",
  );
  const [serverFrom, setServerFrom] = useState<ServerOutcome>("official");

  const settled = (outcome: ServerOutcome) => {
    markServerAck();
    setServerFrom(outcome);
    setStep("login");
  };

  if (step === "invite") {
    return (
      <InviteStep
        onSkip={() => setStep("server")}
        onNeedServer={() => setStep("server")}
        onDone={() => settled("invite")}
      />
    );
  }
  if (step === "server") {
    return (
      <ServerStep onBack={() => setStep("invite")} onDone={() => settled("custom")} />
    );
  }
  return (
    <StepFrame
      // No way back out of a run that never asked anything — "Run setup again"
      // is the way to revisit those answers.
      onBack={
        serverAck && serverFrom === "official"
          ? undefined
          : () => setStep(serverFrom === "invite" ? "invite" : "server")
      }
      rerun
    >
      <LoginScreen embedded />
    </StepFrame>
  );
}
