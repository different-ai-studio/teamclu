import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AgentReplyAttachment } from "@/lib/attachments/agent-reply-attachments";
import {
  fetchAgentReplyAttachmentBytes,
  openOrDownloadAgentReplyAttachment,
} from "@/lib/attachments/download-remote-attachment";

/** Fixed square tile — images and files share the same footprint. */
const TILE_SIZE_CLASS = "h-[88px] w-[88px]";

function formatAttachmentSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentTileButtonClass(canOpen: boolean, busy?: boolean) {
  return cn(
    TILE_SIZE_CLASS,
    "relative shrink-0 overflow-hidden rounded-lg border border-border bg-paper text-left",
    canOpen && !busy
      ? "cursor-pointer hover:bg-selected/30"
      : "cursor-default opacity-70",
    busy && "opacity-60",
  );
}

function FileAttachmentTile({
  item,
  onOpen,
  busy,
}: {
  item: AgentReplyAttachment;
  onOpen: (item: AgentReplyAttachment) => void;
  busy: boolean;
}) {
  const ext = item.filename.split(".").pop()?.toUpperCase() ?? "FILE";
  const sizeLabel = formatAttachmentSize(item.size);
  const canOpen = Boolean(item.url || item.bucketPath);

  return (
    <button
      type="button"
      disabled={!canOpen || busy}
      onClick={() => onOpen(item)}
      className={attachmentTileButtonClass(canOpen, busy)}
      title={item.filename}
    >
      <div className="flex h-full flex-col items-center px-1 py-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-panel font-mono text-[8px] font-bold text-muted-foreground">
          {ext.slice(0, 4)}
        </span>
        <span className="mt-1 min-h-0 w-full flex-1 overflow-hidden text-center text-[10px] font-semibold leading-[1.15] text-foreground line-clamp-2 break-all">
          {item.filename}
        </span>
        {sizeLabel ? (
          <span className="mt-0.5 shrink-0 font-mono text-[9px] leading-none text-faint">
            {sizeLabel}
          </span>
        ) : (
          <span className="shrink-0" aria-hidden />
        )}
      </div>
    </button>
  );
}

function ImageAttachmentTile({
  item,
  onOpen,
  busy,
}: {
  item: AgentReplyAttachment;
  onOpen: (item: AgentReplyAttachment) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const canOpen = Boolean(item.url || item.bucketPath);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const previewObjectUrlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const revokePreviewUrl = () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };

    if (!canOpen) {
      revokePreviewUrl();
      setPreviewUrl(null);
      setPreviewFailed(false);
      return revokePreviewUrl;
    }

    revokePreviewUrl();
    setPreviewUrl(null);
    setPreviewFailed(false);
    let cancelled = false;

    void (async () => {
      try {
        const { bytes, contentType } = await fetchAgentReplyAttachmentBytes(item);
        if (cancelled) return;
        const blob = new Blob([Uint8Array.from(bytes)], {
          type: contentType || item.mime || "image/png",
        });
        const objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        previewObjectUrlRef.current = objectUrl;
        setPreviewUrl(objectUrl);
        setPreviewFailed(false);
      } catch {
        if (!cancelled) setPreviewFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      revokePreviewUrl();
      setPreviewUrl(null);
    };
  }, [canOpen, item.bucketPath, item.url, item.filename, item.mime]);

  return (
    <button
      type="button"
      disabled={!canOpen || busy}
      onClick={() => onOpen(item)}
      className={attachmentTileButtonClass(canOpen, busy)}
      title={item.filename}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={item.filename}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 bg-panel px-1.5">
          <span className="font-mono text-[9px] font-bold uppercase text-muted-foreground">
            {item.filename.split(".").pop()?.slice(0, 4) ?? "IMG"}
          </span>
          <span className="line-clamp-2 text-center text-[10px] text-faint">
            {previewFailed
              ? item.filename
              : t("chat.agentReply.imagePreviewLoading")}
          </span>
        </div>
      )}
    </button>
  );
}

export function AgentReplyAttachments({
  attachments,
  className,
}: {
  attachments: AgentReplyAttachment[];
  className?: string;
}) {
  const { t } = useTranslation();
  const [busyUrl, setBusyUrl] = React.useState<string | null>(null);

  const handleOpen = React.useCallback(
    async (item: AgentReplyAttachment) => {
      if (busyUrl || (!item.url && !item.bucketPath)) return;
      const busyKey = item.url || item.bucketPath || item.filename;
      setBusyUrl(busyKey);
      try {
        await openOrDownloadAgentReplyAttachment(item);
      } catch (error) {
        console.error("[AgentReplyAttachments] open failed:", error);
        const { toast } = await import("sonner");
        toast.error(t("chat.attachment.downloadFailed", "Download failed"));
      } finally {
        setBusyUrl(null);
      }
    },
    [busyUrl, t],
  );

  if (attachments.length === 0) return null;

  return (
    <div
      className={cn(
        "mt-3.5 flex max-w-[min(720px,100%)] flex-col gap-2.5 border-t border-dashed border-border-soft pt-3",
        className,
      )}
      data-testid="agent-reply-attachments"
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        {t("chat.agentReply.attachmentsHeading", {
          count: attachments.length,
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {attachments.map((item) => {
          const busyKey = item.url || item.bucketPath || item.filename;
          const busy = busyUrl === busyKey;
          const key = `${item.filename}-${busyKey}`;
          if (item.isImage) {
            return (
              <ImageAttachmentTile
                key={key}
                item={item}
                onOpen={handleOpen}
                busy={busy}
              />
            );
          }
          return (
            <FileAttachmentTile
              key={key}
              item={item}
              onOpen={handleOpen}
              busy={busy}
            />
          );
        })}
      </div>
    </div>
  );
}
