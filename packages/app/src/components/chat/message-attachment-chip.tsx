import * as React from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatAttachmentBytes } from "@/lib/attachments/composer-attachment";
import { openChatAttachment, openPickedLocalFile } from "@/lib/messages/open-chat-file";
import { cn } from "@/lib/utils";

export type AttachmentChipSurface = "self" | "other" | "composer";

/** Fixed chip width: short names leave blank; long names ellipsis in the filename slot. */
const CHIP_WIDTH_CLASS = "w-[172px] max-w-full shrink-0";

function chipSurfaceClass(surface: AttachmentChipSurface, local: boolean) {
  return cn(
    "inline-flex items-center gap-1.5 min-h-7 max-h-7 overflow-hidden px-2 py-1 rounded-[7px] text-xs border",
    CHIP_WIDTH_CLASS,
    surface === "composer" && "bg-panel border-border text-foreground",
    surface === "self" &&
      "border-foreground/14 bg-paper/90 text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35)] dark:border-white/22 dark:bg-white/[0.08] dark:shadow-none",
    surface === "other" && "bg-panel/80 border-border text-ink-2",
    local && "relative pl-2.5 before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:rounded-sm before:bg-faint",
  );
}

function Filename({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "block flex-1 min-w-0 basis-0 truncate font-medium leading-tight text-left",
        className,
      )}
      title={name}
    >
      {name}
    </span>
  );
}

function LocalKindBadge({ peer }: { peer?: boolean }) {
  const { t } = useTranslation();
  const label = peer
    ? t("chat.attachmentLocalPeer", "对方本地")
    : t("chat.attachmentLocal", "本地");
  return (
    <span className="font-mono text-[10px] text-faint flex-shrink-0 whitespace-nowrap">{label}</span>
  );
}

export function MessageCloudAttachmentChip({
  filename,
  remoteUrl,
  surface,
}: {
  filename: string;
  remoteUrl: string;
  surface: AttachmentChipSurface;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState(false);

  const handleClick = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openChatAttachment({ filename, url: remoteUrl });
    } catch (error) {
      console.error("[UserMessage] attachment open/download failed:", error);
      const { toast } = await import("sonner");
      toast.error(t("chat.attachment.downloadFailed", "Download failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, filename, remoteUrl, t]);

  return (
    <button
      type="button"
      data-chat-attachment=""
      data-chat-filename={filename}
      data-chat-url={remoteUrl}
      onClick={() => void handleClick()}
      disabled={busy}
      title={filename}
      className={cn(
        chipSurfaceClass(surface, false),
        "cursor-pointer hover:bg-selected/30 disabled:opacity-60",
      )}
    >
      <Paperclip className="h-3 w-3 flex-shrink-0 opacity-60" />
      <Filename name={filename} className="flex-1 text-left" />
    </button>
  );
}

export function MessageLocalAttachmentChip({
  filename,
  path,
  surface,
}: {
  filename: string;
  path: string;
  surface: AttachmentChipSurface;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState(false);
  const canOpen = surface === "self";

  const handleClick = React.useCallback(async () => {
    if (!canOpen || busy) return;
    setBusy(true);
    try {
      await openPickedLocalFile(path, filename);
    } catch (error) {
      console.error("[UserMessage] local attachment open failed:", error);
      const { toast } = await import("sonner");
      toast.error(t("chat.fileOpen.notFound", "找不到这个文件"));
    } finally {
      setBusy(false);
    }
  }, [busy, canOpen, filename, path, t]);

  const className = cn(
    chipSurfaceClass(surface, true),
    canOpen ? "cursor-pointer hover:bg-selected/30 disabled:opacity-60" : "cursor-default opacity-90",
  );

  const peerTitle = t(
    "chat.attachmentLocalPeerHint",
    "文件在对方电脑上，你只能看到文件名。",
  );

  if (!canOpen) {
    return (
      <span className={className} title={`${filename} — ${peerTitle}`}>
        <Paperclip className="h-3 w-3 flex-shrink-0 opacity-60" />
        <Filename name={filename} className="flex-1" />
        <LocalKindBadge peer />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      title={filename}
      className={className}
    >
      <Paperclip className="h-3 w-3 flex-shrink-0 opacity-60" />
      <Filename name={filename} className="flex-1 text-left" />
      <LocalKindBadge />
    </button>
  );
}

export function ComposerCloudFileChip({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <div className={cn(chipSurfaceClass("composer", false), "pr-1")} title={name}>
      <FileText className="h-3 w-3 flex-shrink-0 opacity-60 text-muted-foreground" />
      <Filename name={name} className="flex-1 min-w-0" />
      <button
        type="button"
        onClick={onRemove}
        className="p-0.5 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label="remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function ComposerLocalFileChip({
  name,
  size,
  path,
  onRemove,
}: {
  name: string;
  size: number;
  path: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const sizeLabel = formatAttachmentBytes(size);
  return (
    <div
      className={cn(chipSurfaceClass("composer", true), "pr-1")}
      title={`${path} · ${sizeLabel}`}
    >
      <FileText className="h-3 w-3 flex-shrink-0 opacity-60 text-muted-foreground" />
      <Filename name={name} className="flex-1 min-w-0" />
      <span className="font-mono text-[10px] text-faint flex-shrink-0 whitespace-nowrap">
        {t("chat.attachmentLocal", "本地")}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="p-0.5 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label="remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}