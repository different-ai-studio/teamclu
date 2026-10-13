import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CloudApiError } from "@/lib/backend/cloud-api/http";
import {
  closeSupportSession,
  fetchSupportSession,
  redeemSupportCode,
  submitSupportConclusion,
} from "@/lib/support/api";
import {
  openSupportAgentSession,
  pollStableAgentReply,
  truncateConclusion,
} from "@/lib/support/handoff";
import { SettingCard } from "./shared";

export function SupportRedeemCard() {
  const { t } = useTranslation();
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [bundle, setBundle] = React.useState<unknown>(null);
  const [conclusion, setConclusion] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [agentQuiet, setAgentQuiet] = React.useState(false);
  const [agentSessionId, setAgentSessionId] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!sessionId || bundle) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchSupportSession(sessionId)
        .then((view) => {
          if (cancelled) return;
          setStatus(view.status);
          if (view.bundle) setBundle(view.bundle);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, bundle]);

  React.useEffect(() => {
    if (!bundle || !sessionId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const opened = await openSupportAgentSession(bundle);
        if (controller.signal.aborted) return;
        setAgentSessionId(opened.sessionId);
        const reply = await pollStableAgentReply(
          opened.sessionId,
          opened.agentActorId,
          controller.signal,
        );
        if (!reply || controller.signal.aborted) {
          if (!controller.signal.aborted) setAgentQuiet(true);
          return;
        }
        await submitSupportConclusion(sessionId, truncateConclusion(reply));
        if (!controller.signal.aborted) {
          setConclusion(truncateConclusion(reply));
          setStatus("concluded");
        }
      } catch (error) {
        if (!controller.signal.aborted) setNote(errorText(error));
      }
    })();
    return () => controller.abort();
  }, [bundle, sessionId]);

  async function join() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const redeemed = await redeemSupportCode(trimmed);
      setSessionId(redeemed.sessionId);
      setStatus(redeemed.status);
      setBundle(null);
    } catch (error) {
      setNote(redeemNote(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!sessionId || busy) return;
    const text = truncateConclusion(conclusion);
    if (!text) return;
    setBusy(true);
    abortRef.current?.abort();
    try {
      await submitSupportConclusion(sessionId, text);
      setStatus("concluded");
      setNote(null);
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!sessionId || busy) return;
    setBusy(true);
    abortRef.current?.abort();
    try {
      await closeSupportSession(sessionId);
      setStatus("closed");
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const waiting = sessionId && !bundle && status !== "expired" && status !== "rejected" && status !== "closed";

  return (
    <SettingCard>
      <h3 className="text-[13px] font-semibold text-foreground">
        {t("settings.diagnostics.supportTitle", "接入用户的支持助手")}
      </h3>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        {t(
          "settings.diagnostics.supportDescription",
          "用户读出短码后接入。对方点允许后，诊断包会交给本机 agent，回复会写回给用户。",
        )}
      </p>

      {!sessionId && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void join();
            }}
            placeholder={t("settings.diagnostics.supportCodePlaceholder", "XXXX-XXXX")}
            className="max-w-[180px] font-mono text-[13px] uppercase"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <Button type="button" onClick={() => void join()} disabled={busy || !code.trim()} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("settings.diagnostics.supportJoin", "接入")}
          </Button>
        </div>
      )}

      {waiting && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("settings.diagnostics.supportWaiting", "已接入，等待对方允许并上传诊断包。")}
        </p>
      )}

      {bundle != null && (
        <div className="mt-3 space-y-3">
          <p className="text-[12.5px] text-muted-foreground">
            {agentSessionId
              ? t("settings.diagnostics.supportAnalyzing", "诊断包已交给本机会话里的 agent。")
              : t("settings.diagnostics.supportBundleReady", "诊断包已到。本机 agent 没能接上时，可以直接写结论。")}
          </p>
          <pre className="max-h-64 overflow-auto rounded-[8px] border border-border-soft bg-background p-3 font-mono text-[11px] text-ink-2">
            {JSON.stringify(bundle, null, 2)}
          </pre>
          <Textarea
            value={conclusion}
            onChange={(event) => setConclusion(event.target.value)}
            placeholder={t("settings.diagnostics.supportConclusionPlaceholder", "写给用户的结论")}
            className="min-h-24 text-[13px]"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !conclusion.trim() || status === "concluded"}
            >
              {t("settings.diagnostics.supportSubmit", "发送结论")}
            </Button>
          </div>
        </div>
      )}

      {status === "concluded" && (
        <p className="mt-3 text-[13px] text-foreground">
          {t("settings.diagnostics.supportSent", "结论已发给用户。")}
        </p>
      )}
      {(status === "expired" || status === "rejected" || status === "closed") && !bundle && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          {status === "expired"
            ? t("settings.diagnostics.supportExpired", "短码已过期。")
            : t("settings.diagnostics.supportEnded", "这场支持已结束。")}
        </p>
      )}
      {agentQuiet && (
        <p className="mt-3 text-[12.5px] text-muted-foreground">
          {t("settings.diagnostics.supportAgentQuiet", "本地 agent 还没有回复，可以直接写结论。")}
        </p>
      )}
      {note && <p className="mt-3 text-[12.5px] text-muted-foreground">{note}</p>}
      {sessionId && status !== "closed" && (
        <div className="mt-3">
          <Button type="button" variant="outline" onClick={() => void close()} disabled={busy}>
            {t("settings.diagnostics.supportClose", "结束")}
          </Button>
        </div>
      )}
    </SettingCard>
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function redeemNote(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  if (error instanceof CloudApiError) {
    if (error.code === "already_redeemed") {
      return t("settings.diagnostics.supportAlreadyRedeemed", "这个短码已经有人接入。");
    }
    if (error.code === "expired") {
      return t("settings.diagnostics.supportExpired", "短码已过期。");
    }
    if (error.code === "not_found") {
      return t("settings.diagnostics.supportNotFound", "没有这场支持。");
    }
  }
  return errorText(error);
}
