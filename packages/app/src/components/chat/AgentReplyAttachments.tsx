import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AgentReplyAttachment } from "@/lib/attachments/agent-reply-attachments";
import {
  fetchAgentReplyAttachmentBytes,
  openOrDownloadAgentReplyAttachment,
} from "@/lib/attachments/download-remote-attachment";

function formatAttachmentSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileAttachmentChip({
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
      className={cn(
        "inline-flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-paper px-[11px] py-2 text-left",
        canOpen
          ? "cursor-pointer hover:bg-selected/40"
          : "cursor-default opacity-70",
      )}
      title={item.filename}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-panel font-mono text-[9px] font-bold text-muted-foreground">
        {ext.slice(0, 4)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-foreground">
          {item.filename}
        </span>
        {sizeLabel ? (
          <span className="mt-0.5 block font-mono text-[11px] text-faint">
            {sizeLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ImageAttachmentPreview({
  item,
  onOpen,
}: {
  item: AgentReplyAttachment;
  onOpen: (item: AgentReplyAttachment) => void;
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
      disabled={!canOpen}
      onClick={() => onOpen(item)}
      className={cn(
        "max-w-[320px] overflow-hidden rounded-lg border border-border bg-paper text-left",
        canOpen ? "cursor-pointer hover:opacity-95" : "cursor-default opacity-80",
      )}
    >
      <div className="flex h-[140px] items-center justify-center bg-panel">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={item.filename}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-[12px] text-faint">
            {previewFailed
              ? item.filename
              : t("chat.agentReply.imagePreviewLoading")}
          </span>
        )}
      </div>
      <div className="border-t border-border-soft px-2.5 py-1.5 font-mono text-[11px] text-faint truncate">
        {item.filename}
      </div>
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

  const images = attachments.filter((a) => a.isImage);
  const files = attachments.filter((a) => !a.isImage);

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
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((item) => (
            <ImageAttachmentPreview
              key={`${item.filename}-${item.url || item.bucketPath}`}
              item={item}
              onOpen={handleOpen}
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {files.map((item) => (
            <FileAttachmentChip
              key={`${item.filename}-${item.url || item.bucketPath}`}
              item={item}
              onOpen={handleOpen}
              busy={busyUrl === (item.url || item.bucketPath)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
