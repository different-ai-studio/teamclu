import * as React from "react";
import { Check, ChevronDown, Loader2, Mic, Settings2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  installLocalVoiceInput,
  refreshVoiceInputStatus,
  startLocalVoiceInput,
  stopLocalVoiceInput,
  type VoiceRoute,
  type VoiceSegment,
} from "@/lib/voice/local-voice-input";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import { PromptInputButton } from "@/packages/ai/prompt-input-ui";
import { useVoiceInputStore, type VoiceInputMode } from "@/stores/voice-input";
import { isVoiceInputMainDisabled } from "@/lib/voice/voice-input-availability";
import type { VoiceModelVariant } from "@/lib/voice/voice-models";
import { cn, isTauri } from "@/lib/utils";
import { VoiceModelInstallDialog } from "./VoiceModelInstallDialog";

interface VoiceInputControlProps {
  sessionId: string | null;
  engagedAgents: AttachedAgent[];
  onSegment: (segment: VoiceSegment, sessionId: string, route: VoiceRoute) => Promise<void>;
}

export function VoiceInputControl({
  sessionId,
  engagedAgents,
  onSegment,
}: VoiceInputControlProps) {
  const { t } = useTranslation();
  const status = useVoiceInputStore((state) => state.status);
  const mode = useVoiceInputStore((state) => state.mode);
  const recordingId = useVoiceInputStore((state) => state.recordingId);
  const recordingSessionId = useVoiceInputStore((state) => state.recordingSessionId);
  const installProgress = useVoiceInputStore((state) => state.installProgress);
  const error = useVoiceInputStore((state) => state.error);
  const setMode = useVoiceInputStore((state) => state.setMode);
  const setError = useVoiceInputStore((state) => state.setError);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState<VoiceModelVariant>("q8");
  const [targetAgentId, setTargetAgentId] = React.useState<string | null>(null);
  const recordingSessionRef = React.useRef<string | null>(null);
  const desktop = isTauri();

  React.useEffect(() => {
    if (!desktop) return;
    void refreshVoiceInputStatus().catch((error) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }, [desktop, setError]);

  React.useEffect(() => {
    if (!error) return;
    void import("sonner").then(({ toast }) => {
      toast.error(error);
      setError(null);
    });
  }, [error, setError]);

  React.useEffect(() => {
    if (status?.installedModel) setSelectedModel(status.installedModel);
  }, [status?.installedModel]);

  React.useEffect(() => {
    if (!recordingId) {
      recordingSessionRef.current = null;
      return;
    }
    if (
      recordingSessionRef.current &&
      sessionId !== recordingSessionRef.current
    ) {
      void stopLocalVoiceInput();
    }
  }, [recordingId, sessionId]);

  const begin = React.useCallback(
    async (selectedMode: VoiceInputMode | null, selectedAgentId?: string | null) => {
      if (recordingId) return;
      const latest = await refreshVoiceInputStatus();
      if (!latest.supported) {
        const { toast } = await import("sonner");
        toast.error(latest.reason || t("chat.voice.unsupported", "本机暂不支持本地语音输入"));
        return;
      }
      if (!latest.installed) {
        setInstallDialogOpen(true);
        return;
      }
      if (!sessionId) {
        const { toast } = await import("sonner");
        toast.info(t("chat.voice.sessionRequired", "请先创建会话，再开始录音"));
        return;
      }
      if (!selectedMode) {
        setMenuOpen(true);
        return;
      }
      let route: VoiceRoute = { mode: "silent" };
      if (selectedMode === "trigger") {
        const agent =
          engagedAgents.find((candidate) => candidate.id === selectedAgentId) ??
          (engagedAgents.length === 1 ? engagedAgents[0] : null);
        if (!agent) {
          setMenuOpen(true);
          return;
        }
        setTargetAgentId(agent.id);
        route = { mode: "trigger", agent };
      }
      recordingSessionRef.current = sessionId;
      await startLocalVoiceInput({ sessionId, route, onSegment });
    },
    [engagedAgents, onSegment, recordingId, sessionId, t],
  );

  const choose = (selectedMode: VoiceInputMode, agentId?: string) => {
    setMode(selectedMode);
    setTargetAgentId(agentId ?? null);
    setMenuOpen(false);
    void begin(selectedMode, agentId).catch(async (error) => {
      const { toast } = await import("sonner");
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  const handleMainClick = () => {
    if (recordingId) {
      if (recordingSessionId === sessionId) void stopLocalVoiceInput();
      return;
    }
    void begin(mode, targetAgentId).catch(async (error) => {
      const { toast } = await import("sonner");
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  const handleInstall = () => {
    void installLocalVoiceInput(selectedModel).catch(async (error) => {
      const { toast } = await import("sonner");
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  if (!desktop) return null;
  const installing = status?.installing === true;
  const installed = status?.installed === true;
  const recordingHere = recordingId != null && recordingSessionId === sessionId;
  const recordingElsewhere = recordingId != null && !recordingHere;
  const mainDisabled = isVoiceInputMainDisabled({
    hasSession: Boolean(sessionId),
    installed,
    installing,
    recordingElsewhere,
    supported: status?.supported !== false,
  });
  const modeLabel =
    mode === "trigger"
      ? t("chat.voice.trigger", "触发 Agent")
      : mode === "silent"
        ? t("chat.voice.silent", "静默")
        : t("chat.voice.chooseMode", "选择录音模式");
  const title =
    status?.supported === false
      ? status.reason || t("chat.voice.unsupported", "本机暂不支持本地语音输入")
      : recordingElsewhere
        ? t("chat.voice.recordingElsewhere", "正在另一个对话中录音")
        : recordingHere
          ? t("chat.voice.stop", "停止录音")
          : installing
            ? t("chat.voice.downloading", "正在下载本地语音模型 {{progress}}%", {
                progress: Math.round(installProgress * 100),
              })
            : !installed
              ? t("chat.voice.downloadModel", "下载本地语音模型")
              : t("chat.voice.start", "开始录音（{{mode}}）", { mode: modeLabel });

  return (
    <>
      <div className="flex shrink-0 items-center">
        <PromptInputButton
          type="button"
          className={cn(
            "h-8 w-8 px-0 text-muted-foreground hover:text-foreground",
            !mainDisabled && "text-foreground",
            recordingHere && "bg-foreground text-background hover:bg-foreground/90 hover:text-background",
          )}
          disabled={mainDisabled}
          title={title}
          aria-label={title}
          data-testid="voice-input-toggle"
          onClick={handleMainClick}
        >
          {installing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : recordingHere ? (
            <Square className="h-3 w-3 fill-current" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </PromptInputButton>
        {!recordingId ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-5 rounded-l-none px-0 text-muted-foreground hover:text-foreground"
                disabled={installing || status?.supported === false}
                aria-label={t("chat.voice.chooseMode", "选择录音模式")}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[15rem]">
              <DropdownMenuLabel className="text-[11px] text-faint">
                {t("chat.voice.sendMode", "自动发送方式")}
              </DropdownMenuLabel>
              <DropdownMenuItem disabled={!sessionId} onSelect={() => choose("silent")}>
                <span className="flex-1">
                  {t("chat.voice.silent", "静默")}
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {t("chat.voice.silentHint", "不 @ 任何 Agent")}
                  </span>
                </span>
                {mode === "silent" ? <Check className="h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
              {engagedAgents.length === 0 ? (
                <DropdownMenuItem disabled>
                  {t("chat.voice.noAgent", "没有可触发的 Agent")}
                </DropdownMenuItem>
              ) : (
                engagedAgents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    disabled={!sessionId}
                    onSelect={() => choose("trigger", agent.id)}
                  >
                    <span className="flex-1">
                      {t("chat.voice.triggerAgent", "触发 {{name}}", {
                        name: agent.displayName,
                      })}
                    </span>
                    {mode === "trigger" && targetAgentId === agent.id ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : null}
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setSelectedModel(status?.installedModel ?? "q8");
                  setInstallDialogOpen(true);
                }}
              >
                <Settings2 className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">
                  {t("chat.voice.modelSettings", "语音模型设置")}
                </span>
                {status?.installedModel ? (
                  <span className="font-mono text-[10.5px] uppercase text-faint">
                    {status.installedModel}
                  </span>
                ) : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <VoiceModelInstallDialog
        open={installDialogOpen}
        installing={installing}
        progress={installProgress}
        selectedModel={selectedModel}
        installed={installed}
        installedModel={status?.installedModel}
        onOpenChange={setInstallDialogOpen}
        onSelectedModelChange={setSelectedModel}
        onInstall={handleInstall}
      />
    </>
  );
}

export function VoiceRecordingStatus({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  const recordingId = useVoiceInputStore((state) => state.recordingId);
  const recordingSessionId = useVoiceInputStore((state) => state.recordingSessionId);
  const mode = useVoiceInputStore((state) => state.mode);
  const targetAgentName = useVoiceInputStore((state) => state.targetAgentName);
  const elapsedMs = useVoiceInputStore((state) => state.elapsedMs);
  const level = useVoiceInputStore((state) => state.level);
  if (!recordingId || recordingSessionId !== sessionId) return null;
  const seconds = Math.floor(elapsedMs / 1000);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
  const routeLabel =
    mode === "trigger" && targetAgentName
      ? t("chat.voice.triggering", "触发 · {{name}}", { name: targetAgentName })
      : t("chat.voice.silentRecording", "静默录音");
  const activeBars = Math.max(1, Math.min(5, Math.ceil(level * 100)));
  return (
    <div
      className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-border-soft bg-panel px-3 py-1.5 text-[11.5px] text-ink-2"
      data-testid="voice-recording-status"
    >
      <span className="flex h-3 items-end gap-px" aria-hidden>
        {[1, 2, 3, 4, 5].map((bar) => (
          <span
            key={bar}
            className={cn("w-0.5 rounded-sm bg-faint", bar <= activeBars && "bg-foreground")}
            style={{ height: `${4 + bar * 1.5}px` }}
          />
        ))}
      </span>
      <span className="font-medium">{t("chat.voice.recording", "录音中")}</span>
      <span className="font-mono text-faint">{time}</span>
      <span className="text-faint">·</span>
      <span>{routeLabel}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto h-6 px-2 text-[11px]"
        onClick={() => void stopLocalVoiceInput()}
      >
        {t("chat.voice.stop", "停止录音")}
      </Button>
    </div>
  );
}
