import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { probeCloudApi } from "@/lib/config/bootstrap";
import {
  displayHost,
  getCloudApiUrlOverride,
  getDefaultCloudApiUrl,
  getEffectiveServerConfigSync,
  normalizeCloudApiUrl,
} from "@/lib/config/server-config";
import { switchExtensionServer } from "@/lib/extension/switch-server";

async function signOutForSwitch(): Promise<void> {
  const { useAuthStore } = await import("@/stores/auth-store");
  await useAuthStore.getState().signOut("extension_server_switch");
}

function isInvalidServerUrl(error: unknown): boolean {
  return error instanceof Error && error.name === "InvalidServerUrlError";
}

function ServerForm({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation();
  const defaultUrl = getDefaultCloudApiUrl();
  const override = getCloudApiUrlOverride();
  const [raw, setRaw] = useState(override ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowUnverified, setAllowUnverified] = useState(false);

  const commit = async (url: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await switchExtensionServer({ url, signedIn, signOut: signOutForSwitch });
    } catch (caught) {
      setError(
        isInvalidServerUrl(caught)
          ? t(
              "auth.onboarding.serverUrlInvalid",
              "Enter a valid http(s) URL, e.g. https://api.example.com",
            )
          : t("settings.extension.server.saveError", "Could not switch server"),
      );
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeCloudApiUrl(raw);
    if (!normalized) {
      setAllowUnverified(false);
      setError(
        t(
          "auth.onboarding.serverUrlInvalid",
          "Enter a valid http(s) URL, e.g. https://api.example.com",
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const probe = await probeCloudApi(normalized);
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
        return;
      }
      await switchExtensionServer({ url: normalized, signedIn, signOut: signOutForSwitch });
    } catch (caught) {
      setError(
        isInvalidServerUrl(caught)
          ? t(
              "auth.onboarding.serverUrlInvalid",
              "Enter a valid http(s) URL, e.g. https://api.example.com",
            )
          : t("settings.extension.server.saveError", "Could not switch server"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="extension-server-form">
      {signedIn ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {t(
            "settings.extension.server.signOutHint",
            "Switching signs you out. Sign in again on the server you pick.",
          )}
        </p>
      ) : null}
      {defaultUrl ? (
        <button
          type="button"
          onClick={() => void commit(null)}
          disabled={busy || !override}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-selected/50 disabled:cursor-default disabled:hover:bg-background"
        >
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-foreground">
              {t("auth.onboarding.serverOfficial", "Official server")}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {displayHost(defaultUrl)}
            </span>
          </span>
          {!override ? (
            <span className="shrink-0 font-mono text-[10px] text-faint">
              {t("settings.extension.server.current", "Current")}
            </span>
          ) : null}
        </button>
      ) : null}

      <form onSubmit={(event) => void onSubmit(event)} className="space-y-2">
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-ink-2">
            {t("auth.onboarding.serverCustom", "Custom server")}
          </span>
          <Input
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              setError(null);
              setAllowUnverified(false);
            }}
            placeholder="https://api.example.com"
            spellCheck={false}
            autoCapitalize="none"
            disabled={busy}
            aria-label={t("auth.onboarding.serverUrlLabel", "Cloud API URL")}
            className="h-9 font-mono text-[12.5px]"
          />
        </label>
        {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        <Button type="submit" variant="outline" size="sm" className="h-9" disabled={busy || !raw.trim()}>
          {busy
            ? t("auth.onboarding.serverChecking", "Checking…")
            : t("common.save", "Save")}
        </Button>
        {allowUnverified && !busy ? (
          <button
            type="button"
            onClick={() => void commit(raw)}
            className="block text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("auth.onboarding.serverSaveAnyway", "Save it anyway")}
          </button>
        ) : null}
      </form>
    </div>
  );
}

function currentHostLabel(unset: string): { host: string; custom: boolean } {
  const url = getEffectiveServerConfigSync().cloudApiUrl;
  return {
    host: url ? displayHost(url) : unset,
    custom: Boolean(getCloudApiUrlOverride()),
  };
}

/** Cloud API switch for the extension login footer and the extension settings page. */
export function ExtensionServerSwitch({
  signedIn,
  variant,
}: {
  signedIn: boolean;
  variant: "footer" | "panel";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(variant === "panel");
  const { host, custom } = currentHostLabel(t("auth.onboarding.serverUnset", "no server configured"));
  const customTag = t("auth.onboarding.serverCustomTag", "custom");

  if (variant === "footer") {
    return (
      <div className="mt-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex max-w-full items-center gap-1.5 text-left font-mono text-[10px] text-faint/70 transition-colors hover:text-foreground"
        >
          <span className="truncate">
            {host}
            {custom ? ` · ${customTag}` : ""}
          </span>
          <span className="shrink-0 font-sans text-[11px] underline-offset-2 hover:underline">
            {t("auth.serverSwitch.change", "Switch server")}
          </span>
        </button>
        {open ? (
          <div className="mt-3 w-full max-w-sm rounded-[12px] border border-border bg-paper p-3 text-left">
            <ServerForm signedIn={signedIn} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-ink-2">
        {host}
        {custom ? <span className="text-faint"> · {customTag}</span> : null}
      </p>
      <ServerForm signedIn={signedIn} />
    </div>
  );
}
