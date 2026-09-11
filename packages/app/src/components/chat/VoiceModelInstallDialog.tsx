import { Check, Download, HardDrive, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  VOICE_MODEL_OPTIONS,
  type VoiceModelVariant,
} from "@/lib/voice/voice-models";
import { cn } from "@/lib/utils";

interface VoiceModelInstallDialogProps {
  open: boolean;
  installing: boolean;
  progress: number;
  selectedModel: VoiceModelVariant;
  installedModel?: VoiceModelVariant | null;
  onOpenChange: (open: boolean) => void;
  onSelectedModelChange: (model: VoiceModelVariant) => void;
  onInstall: () => void;
}

export function VoiceModelInstallDialog({
  open,
  installing,
  progress,
  selectedModel,
  installedModel,
  onOpenChange,
  onSelectedModelChange,
  onInstall,
}: VoiceModelInstallDialogProps) {
  const { t } = useTranslation();
  const selectedIsInstalled = installedModel === selectedModel;

  return (
    <Dialog open={open} onOpenChange={(next) => !installing && onOpenChange(next)}>
      <DialogContent className="overflow-hidden rounded-[14px] bg-paper p-0 sm:max-w-[440px]">
        <DialogHeader className="gap-1.5 border-b border-border-soft px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Download className="h-4 w-4" />
            {t("chat.voice.installTitle", "安装本地语音模型")}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            {t("chat.voice.installDescription", "选择 SenseVoiceSmall 精度。模型仅下载一次，录音与识别均在本机完成。")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 px-5 py-4">
          {VOICE_MODEL_OPTIONS.map((option) => {
            const selected = selectedModel === option.id;
            const sizeMb = Math.round(option.modelBytes / 1_000_000);
            return (
              <button
                key={option.id}
                type="button"
                disabled={installing}
                onClick={() => onSelectedModelChange(option.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-[10px] border bg-background px-3.5 py-3 text-left transition-colors hover:bg-panel disabled:cursor-default disabled:opacity-70",
                  selected ? "border-foreground/35 bg-panel" : "border-border",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-foreground bg-foreground text-background" : "border-faint",
                  )}
                  aria-hidden
                >
                  {selected ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                    {option.id === "q8"
                      ? t("chat.voice.modelQ8", "Q8 标准")
                      : t("chat.voice.modelF16", "F16 高精度")}
                    {option.recommended ? (
                      <span className="rounded bg-selected px-1.5 py-0.5 text-[9.5px] font-semibold text-ink-2">
                        {t("chat.voice.recommended", "推荐")}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-[11.5px] leading-relaxed text-muted-foreground">
                    {option.id === "q8"
                      ? t("chat.voice.modelQ8Hint", "速度、内存和识别质量更均衡，适合日常录音。")
                      : t("chat.voice.modelF16Hint", "保留更多权重精度，但下载和内存占用更高。")}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-faint">
                  <HardDrive className="h-3 w-3" />
                  {sizeMb} MB
                </span>
              </button>
            );
          })}

          <div className="mt-1 flex items-center gap-2 text-[11px] text-faint">
            <LockKeyhole className="h-3 w-3" />
            {t("chat.voice.localOnly", "音频不会上传；另需约 2 MB 的断句模型。")}
          </div>

          {installing ? (
            <div className="mt-1 space-y-1.5" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-panel">
                <div
                  className="h-full rounded-full bg-foreground transition-[width]"
                  style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }}
                />
              </div>
              <div className="text-right font-mono text-[11px] text-faint">
                {Math.round(progress * 100)}%
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t border-border-soft px-5 py-3">
          <Button type="button" variant="ghost" disabled={installing} onClick={() => onOpenChange(false)}>
            {t("common.cancel", "取消")}
          </Button>
          <Button
            type="button"
            disabled={installing || selectedIsInstalled}
            onClick={onInstall}
            className="bg-foreground text-background hover:bg-foreground/90"
          >
            {installing
              ? t("chat.voice.installing", "正在安装…")
              : selectedIsInstalled
                ? t("chat.voice.installed", "已安装")
                : t("chat.voice.install", "下载并安装")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
