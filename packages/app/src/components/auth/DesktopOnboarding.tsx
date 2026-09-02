import { useState } from "react";
import { AlertCircle, ArrowLeft, Link2, LogIn, RotateCcw, Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { probeCloudApi } from "@/lib/bootstrap";
import { parseInviteTokenInput } from "@/lib/invite-deeplink";
import { confirmInviteLinkToken } from "@/lib/invite-link-confirmation";
import {
  displayHost,
  getCloudApiUrlOverride,
  getDefaultCloudApiUrl,
  getEffectiveServerConfigSync,
  normalizeCloudApiUrl,
  setCloudApiUrlOverride,
} from "@/lib/server-config";
import { useAppVersion } from "@/lib/version";
import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/stores/onboarding";
import { clearSetupSatisfied } from "@/stores/setup";
import { LoginScreen } from "./LoginScreen";

type Step = "choose" | "login" | "invite" | "server";

/**
 * Everything this screen needs to know about the backend, read once.
 *
 * `hasBackendConfig()` answers the same question as `!cloudApiUrl` — both reduce
 * to `Boolean(getCloudApiUrlOverride() ?? env.cloudApiUrl)` — but reaching for
 * it here meant resolving the whole server config twice per render.
 */
function readServerSummary(): {
  cloudApiUrl: string | undefined;
  override: string | null;
  unconfigured: boolean;
} {
  const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl;
  return { cloudApiUrl, override: getCloudApiUrlOverride(), unconfigured: !cloudApiUrl };
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const { cloudApiUrl, override } = readServerSummary();
  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground">
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">
        {children}
        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
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

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-5 inline-flex w-fit items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {t("onboarding.common.back", "Back")}
    </button>
  );
}

function DetailFrame({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <BackButton onClick={onBack} />
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
  active,
  badge,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  caption: React.ReactNode;
  primary?: boolean;
  /** This row describes the state the app is already in. Drawn in `--selected`
   *  ("selected row in panel sections"), not coral: AGENTS.md caps a frame at
   *  two coral spots, and the sign-in chip and the footer already spend both. */
  active?: boolean;
  badge?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex w-full items-center gap-3 rounded-[14px] border border-border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        active ? "bg-selected/70" : "bg-paper hover:bg-selected/45",
      ].join(" ")}
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
      {badge && (
        <span className="shrink-0 rounded-[6px] bg-panel px-2 py-0.5 text-[11px] font-medium text-ink-2">
          {badge}
        </span>
      )}
    </button>
  );
}

function ChooseStep({
  onLogin,
  onInvite,
  onServer,
}: {
  onLogin: () => void;
  onInvite: () => void;
  onServer: () => void;
}) {
  const { t } = useTranslation();
  const { loading, errorMessage } = useAuthStore();
  // The footer already prints the effective URL in coral, but it is 10px type
  // at the bottom of the window — easy to miss, and it says nothing about which
  // of these three entries put the app there. Mark the entry itself too.
  //
  // `unconfigured` means no Cloud API at all: none baked into the build, none
  // set by hand. Signing in and joining a team both dead-end in that state (the
  // login screen refuses to send a code), so say it once up top and point
  // everything at the one entry that can fix it.
  const { override, unconfigured } = readServerSummary();

  /**
   * Run the first-run wizard again — language, runtime, model.
   *
   * Reload rather than flipping state in place: AuthGate reads the setup-ok
   * cache once, at mount (`useState(() => …)`), and half the wizard's inputs
   * (the setup store's probe, the daemon store) were seeded on the way here.
   * A reload re-derives all of it from the two things this clears, which is
   * what makes the re-run identical to a first run.
   */
  const rerunSetup = () => {
    useOnboardingStore.getState().reset();
    clearSetupSatisfied();
    window.location.reload();
  };

  return (
    <Shell>
      {/* Sits inside the drag strip, opposite the traffic lights. Painted after
          the drag region, so it stays clickable. */}
      <button
        type="button"
        onClick={rerunSetup}
        className="absolute right-6 top-6 inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] text-faint transition-colors hover:bg-panel hover:text-foreground"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t("auth.onboarding.rerunSetup", "Run setup again")}
      </button>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <div className="mb-5">
          <h1 className="text-[24px] font-semibold text-foreground">
            {t("auth.onboarding.setupTitle", "Choose setup")}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            {t(
              "auth.onboarding.setupDesc",
              "Sign in, join a team, or connect a self-hosted server.",
            )}
          </p>
        </div>
        {unconfigured && (
          <div className="mb-4 flex items-start gap-2 rounded-[12px] border border-border bg-panel px-3.5 py-3 text-[12px] leading-5 text-ink-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-coral" />
            <span>
              {t(
                "auth.onboarding.noServerNotice",
                "No server address is configured yet. Set your company's Cloud API below — signing in and joining a team both need one.",
              )}
            </span>
          </div>
        )}
        <div className="space-y-3">
          <ChoiceRow
            primary={!unconfigured}
            icon={<LogIn className="h-4 w-4" />}
            title={t("auth.onboarding.signInOrRegister", "Sign in or register")}
            caption={t(
              "auth.onboarding.signInOrRegisterDesc",
              "Sign in directly with a verification code and bind a valid contact method.",
            )}
            disabled={loading || unconfigured}
            onClick={onLogin}
          />
          <ChoiceRow
            icon={<Link2 className="h-4 w-4" />}
            title={t("auth.onboarding.joinTeam", "Join the team")}
            caption={t("auth.onboarding.joinTeamDesc", "Paste an invite link or token to join an existing team.")}
            disabled={loading || unconfigured}
            onClick={onInvite}
          />
          {/* Not disabled while auth is in flight, unlike the two above: this is
              the way out of a backend that is not answering, which is exactly
              when a request is left hanging. */}
          <ChoiceRow
            icon={<Server className="h-4 w-4" />}
            // With nothing configured this is the only entry that does
            // anything, so the accent moves here from the sign-in row.
            primary={unconfigured}
            active={Boolean(override)}
            badge={override ? t("auth.onboarding.serverCustomTag", "custom") : undefined}
            title={t("auth.onboarding.customServer", "Enterprise custom server")}
            caption={
              override ? (
                // Which server, not just that there is one: the address is the
                // whole answer to "what am I about to sign in against". Kept to
                // one line — an internal host with a port and a path wraps to
                // three and leaves this card taller than the two above it.
                <span
                  className="block truncate font-mono text-[11.5px] text-ink-2"
                  title={displayHost(override)}
                >
                  {displayHost(override)}
                </span>
              ) : unconfigured ? (
                t(
                  "auth.onboarding.customServerRequiredDesc",
                  "Start here: enter the Cloud API address of your company's own server.",
                )
              ) : (
                t(
                  "auth.onboarding.customServerDesc",
                  "Point the app at your company's self-hosted Cloud API and sign in there.",
                )
              )
            }
            onClick={onServer}
          />
        </div>
        {errorMessage && (
          <p className="mt-4 rounded-[8px] border border-destructive/20 bg-paper px-3 py-2 text-[12px] leading-5 text-destructive">
            {errorMessage}
          </p>
        )}
      </div>
    </Shell>
  );
}

function InviteStep({ onBack, onNeedLogin }: { onBack: () => void; onNeedLogin: () => void }) {
  const { t } = useTranslation();
  const { setPendingInviteToken, errorMessage } = useAuthStore();
  const [raw, setRaw] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const token = parseInviteTokenInput(raw);
    if (!token) {
      setLocalError(t("auth.onboarding.inviteParseError", "Enter a valid invite token or invite link."));
      return;
    }
    setLocalError(null);
    // Member invites require a real account: stash the token and send the user
    // to sign in. The invite is claimed automatically once they're signed in.
    setPendingInviteToken(token);
    // The user typed this token themselves; skip the deep-link confirmation prompt.
    confirmInviteLinkToken(token);
    onNeedLogin();
  };

  return (
    <DetailFrame onBack={onBack}>
      <form onSubmit={submit} className="rounded-[16px] border border-border bg-paper p-5">
        <h1 className="text-[18px] font-semibold">{t("auth.onboarding.inviteTitle", "Join the team")}</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t("auth.onboarding.inviteDesc", "Paste an invite link or token, then sign in to join. The invite is claimed once you're signed in.")}
        </p>
        <label className="mt-5 block space-y-2">
          <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.inviteLabel", "Invite link or token")}</span>
          <Input value={raw} onChange={(event) => setRaw(event.target.value)} className="h-10 font-mono text-[12px]" />
        </label>
        {(localError || errorMessage) && (
          <p className="mt-3 text-[12px] text-destructive">{localError || errorMessage}</p>
        )}
        <Button type="submit" disabled={!raw.trim()} className="mt-5 h-10 w-full bg-coral text-coral-foreground">
          {t("auth.onboarding.inviteContinueToSignIn", "Continue to sign in")}
        </Button>
      </form>
    </DetailFrame>
  );
}

function ServerStep({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const override = getCloudApiUrlOverride();
  const defaultUrl = getDefaultCloudApiUrl();
  const [raw, setRaw] = useState(override ?? defaultUrl ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Set once a probe has failed, so the user can override a verdict that may be
  // wrong for their situation — configuring a server that is not up yet, or one
  // only reachable from a network they are not on right now.
  const [allowUnverified, setAllowUnverified] = useState(false);

  // A session issued by the previous backend is meaningless against the new one,
  // so reload from scratch instead of trying to migrate state in place.
  const applyAndReload = (value: string | null) => {
    try {
      setCloudApiUrlOverride(value);
    } catch {
      setLocalError(t("auth.onboarding.serverUrlInvalid", "Enter a valid http(s) URL, e.g. https://api.example.com"));
      return;
    }
    window.location.reload();
  };

  // Syntax is not enough. `https://api.example.com111` parses fine, saves fine,
  // and reloads the app into a backend that does not exist — every subsequent
  // failure then looks like a bug somewhere else. Ask the address whether it is
  // a Cloud API before persisting anything.
  const verifyAndApply = async (value: string) => {
    setLocalError(null);
    // Shape first. A scheme-less `api.mycorp.com` is fetched as a URL relative
    // to tauri://localhost, fails, and comes back as "could not reach that
    // address" — sending the user off to check a server that was never asked.
    // The real problem only surfaced later, when setCloudApiUrlOverride threw.
    if (!normalizeCloudApiUrl(value)) {
      setLocalError(
        t("auth.onboarding.serverUrlInvalid", "Enter a valid http(s) URL, e.g. https://api.example.com"),
      );
      return;
    }
    setChecking(true);
    try {
      const probe = await probeCloudApi(value);
      if (!probe.ok) {
        setAllowUnverified(true);
        setLocalError(
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
        return;
      }
      applyAndReload(value);
    } finally {
      setChecking(false);
    }
  };

  return (
    <DetailFrame onBack={onBack}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void verifyAndApply(raw);
        }}
        className="rounded-[16px] border border-border bg-paper p-5"
      >
        <h1 className="text-[18px] font-semibold">{t("auth.onboarding.serverTitle", "Enterprise custom server")}</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t(
            "auth.onboarding.serverDesc",
            "Point the app at a different TeamClu Cloud API. The app reloads and you sign in against that server.",
          )}
        </p>
        <label className="mt-5 block space-y-2">
          <span className="text-[12px] font-medium text-ink-2">
            {t("auth.onboarding.serverUrlLabel", "Cloud API URL")}
          </span>
          <Input
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              setLocalError(null);
              // A different address has not been rejected yet, so it does not
              // inherit the previous one's "save anyway".
              setAllowUnverified(false);
            }}
            placeholder="https://api.example.com"
            spellCheck={false}
            autoCapitalize="none"
            className="h-10 font-mono text-[12px]"
          />
        </label>
        {defaultUrl && (
          <p className="mt-2 font-mono text-[11px] text-faint">
            {t("auth.onboarding.serverDefaultHint", "Built-in default: {{url}}", { url: defaultUrl })}
          </p>
        )}
        {localError && <p className="mt-3 text-[12px] text-destructive">{localError}</p>}
        <Button
          type="submit"
          disabled={checking || !raw.trim() || raw.trim() === override}
          className="mt-5 h-10 w-full bg-coral text-coral-foreground"
        >
          {checking
            ? t("auth.onboarding.serverChecking", "Checking…")
            : t("auth.onboarding.serverSaveAndReload", "Save and reload")}
        </Button>
        {allowUnverified && !checking && (
          <button
            type="button"
            onClick={() => applyAndReload(raw)}
            className="mt-3 w-full rounded-[6px] py-1 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t("auth.onboarding.serverSaveAnyway", "Save it anyway")}
          </button>
        )}
        {/* `defaultUrl` matters: with no baked default, "reset" would drop the
            app back to having no backend at all — the state this screen exists
            to get out of. Overwriting the address still works. */}
        {override && defaultUrl && (
          <button
            type="button"
            onClick={() => applyAndReload(null)}
            className="mt-3 w-full rounded-[6px] py-1 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t("auth.onboarding.serverReset", "Reset to the built-in default")}
          </button>
        )}
      </form>
    </DetailFrame>
  );
}

export function DesktopOnboarding() {
  const [step, setStep] = useState<Step>("choose");

  if (step === "login") {
    return (
      <DetailFrame onBack={() => setStep("choose")}>
        <LoginScreen embedded />
      </DetailFrame>
    );
  }
  if (step === "invite") return <InviteStep onBack={() => setStep("choose")} onNeedLogin={() => setStep("login")} />;
  if (step === "server") return <ServerStep onBack={() => setStep("choose")} />;

  return (
    <ChooseStep
      onLogin={() => setStep("login")}
      onInvite={() => setStep("invite")}
      onServer={() => setStep("server")}
    />
  );
}
