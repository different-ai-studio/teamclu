import * as React from "react";
import { FileText, Folder, User, UserRound, Paperclip, ChevronDown, ChevronUp, Zap, Command as CommandIcon, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useActorDisplayName } from "@/hooks/use-actor-display-name";
import { ClickableImage, LocalImage, resolveImagePath } from "@/packages/ai/message";
import { getTrailingPathLabel } from "@/packages/ai/chip-labels";
import { hasStructuredMentionLines } from "@/lib/outgoing-mention-content";
import { parseSentPageChip } from "@/lib/expand-page-link-tokens";
import { pageLinkChipLabel, parsePageLinkBody } from "@/lib/page-link-token";
import type { PageContext } from "@/lib/embed-page-context";
import { openOrDownloadRemoteAttachment } from "@/lib/download-remote-attachment";
import { getCachedAttachmentPath, normalizeAttachmentUrlKey } from "@/lib/attachment-download-index";
import { isTauri } from "@/lib/utils";

/** Max pixel height before the message is collapsed */
const COLLAPSED_HEIGHT = 200;

/** Compact square thumbnail for images embedded in user message bubbles */
const USER_MESSAGE_IMAGE_THUMB_CLASS =
  "size-12 shrink-0 rounded object-cover border border-white/20";

function splitMentionLabels(body: string): string[] {
  return body.split(",").map((p) => p.trim()).filter(Boolean);
}

function parseStructuredMentionPrefix(content: string): {
  parts: Array<{
    type: "mentioned";
    content: string;
    people: string[];
    mentionKind: "agent" | "human";
  }>;
  body: string;
} {
  const parts: Array<{
    type: "mentioned";
    content: string;
    people: string[];
    mentionKind: "agent" | "human";
  }> = [];
  let body = content;
  while (body.length > 0) {
    const agentMatch = body.match(/^\[Mentioned agents: ([^\]]+)\](?:\r?\n)?/);
    if (agentMatch) {
      const people = splitMentionLabels(agentMatch[1] ?? "");
      if (people.length > 0) {
        parts.push({
          type: "mentioned",
          content: agentMatch[1] ?? "",
          people,
          mentionKind: "agent",
        });
      }
      body = body.slice(agentMatch[0].length);
      continue;
    }
    const humanMatch = body.match(/^\[Mentioned humans: ([^\]]+)\](?:\r?\n)?/);
    if (humanMatch) {
      const people = splitMentionLabels(humanMatch[1] ?? "");
      if (people.length > 0) {
        parts.push({
          type: "mentioned",
          content: humanMatch[1] ?? "",
          people,
          mentionKind: "human",
        });
      }
      body = body.slice(humanMatch[0].length);
      continue;
    }
    break;
  }
  return { parts, body: body.replace(/^\s+/, "") };
}

function LocalImageCard({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <LocalImage
      src={src}
      alt={alt}
      className={USER_MESSAGE_IMAGE_THUMB_CLASS}
      onError={() => setFailed(true)}
    />
  );
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(path);
}

type UserMessagePart = {
  type:
    | "text"
    | "file"
    | "directory"
    | "image"
    | "mentioned"
    | "attachment"
    | "filemention"
    | "role"
    | "skill"
    | "command"
    | "actorMention"
    | "pageLink";
  content: string;
  people?: string[];
  mentionKind?: "agent" | "human";
  dataUrl?: string;
  size?: string;
  fullPath?: string;
  remoteUrl?: string;
  pageContext?: PageContext;
  pageUrl?: string;
};

function isUserMessageImagePart(part: UserMessagePart): boolean {
  if (part.type === "image") return true;
  if (part.type === "attachment") {
    const attachmentPath = part.fullPath ?? part.content;
    return Boolean(attachmentPath && isImagePath(attachmentPath));
  }
  return false;
}

type UserMessageRenderSegment =
  | { kind: "single"; part: UserMessagePart; index: number }
  | { kind: "imageRow"; parts: UserMessagePart[]; index: number };

/** Collapse consecutive image parts (ignoring whitespace-only text between) into one row. */
function groupUserMessageParts(parts: UserMessagePart[]): UserMessageRenderSegment[] {
  const segments: UserMessageRenderSegment[] = [];
  let imageRun: UserMessagePart[] = [];
  let runStartIndex = -1;

  const flushImages = () => {
    if (imageRun.length === 0) return;
    segments.push({ kind: "imageRow", parts: imageRun, index: runStartIndex });
    imageRun = [];
    runStartIndex = -1;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (isUserMessageImagePart(part)) {
      if (imageRun.length === 0) runStartIndex = i;
      imageRun.push(part);
    } else if (part.type === "text" && !part.content.trim() && imageRun.length > 0) {
      continue;
    } else {
      flushImages();
      segments.push({ kind: "single", part, index: i });
    }
  }
  flushImages();
  return segments;
}

function renderUserMessageImage(
  part: UserMessagePart,
  basePath: string | undefined,
) {
  if (part.type === "image") {
    if (part.dataUrl) {
      return (
        <ClickableImage
          src={part.dataUrl}
          alt={part.content}
          className={USER_MESSAGE_IMAGE_THUMB_CLASS}
        />
      );
    }
    return (
      <LocalImageCard
        src={resolveImagePath(part.content, basePath)}
        alt={part.content}
      />
    );
  }

  const attachmentPath = part.fullPath ?? part.content;
  return (
    <LocalImageCard
      src={resolveImagePath(attachmentPath, basePath)}
      alt={part.content}
    />
  );
}

function parseSlashToken(body: string): { type: "role" | "skill" | "command"; name: string } {
  if (body.startsWith("role:")) return { type: "role", name: body.slice("role:".length) };
  if (body.startsWith("skill:")) return { type: "skill", name: body.slice("skill:".length) };
  if (body.startsWith("command:")) return { type: "command", name: body.slice("command:".length) };
  return { type: "skill", name: body };
}

function stripChipMetadata(content: string): string {
  const trimmed = content.trim();
  const separatorIndex = trimmed.indexOf("|instruction:");
  return separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
}

function formatAgentMentionLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function AgentMentionHeader({ names }: { names: string[] }) {
  const labels = names.map(formatAgentMentionLabel).filter(Boolean);
  if (labels.length === 0) return null;

  return (
    <div
      className="-mx-4 mb-2 border-b border-[rgba(26,26,20,0.06)] dark:border-white/8"
      data-testid="agent-mention-header"
    >
      <div className="flex items-center gap-2 min-w-0 px-4 pb-1.5">
        <span className="font-mono text-[9px] font-semibold tracking-[0.04em] text-coral shrink-0">
          AGENT
        </span>
        <span className="text-[12.5px] font-semibold text-foreground truncate">
          {labels.join(", ")}
        </span>
      </div>
    </div>
  );
}

const INLINE_CHIP_BASE =
  "message-inline-chip inline-flex items-center gap-1 h-[22px] px-[9px] mx-0.5 rounded-md text-xs font-medium leading-none align-middle";

function HumanMentionChip({ name, title }: { name: string; title?: string }) {
  return (
    <span
      className={cn(
        "message-inline-chip human-mention-inline inline-flex items-center min-h-[22px] py-px px-0.5 mx-0.5",
        "text-xs font-medium leading-snug align-middle",
        "text-[#5a6270] dark:text-[#b8c5d0]",
      )}
      title={title}
    >
      <span className="text-faint">@</span>
      <span className="truncate max-w-[200px]">{name}</span>
    </span>
  );
}

function ActorMentionChip({ actorId }: { actorId: string }) {
  const name = useActorDisplayName(actorId);
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 mx-0.5 rounded-md text-xs bg-[#edf2f7] text-[#5a7086] dark:bg-[#202a34] dark:text-[#aec3d6]">
      <User className="h-3 w-3" />
      <span className="truncate max-w-[200px]">@{name || actorId}</span>
    </span>
  );
}

function MentionDeliveryMetaLine({
  actorIds,
  snapshot,
}: {
  actorIds: string[];
  snapshot?: Record<string, "ready" | "offline" | "stale">;
}) {
  const { t } = useTranslation();
  const flagged = actorIds.filter((id) => {
    const v = snapshot?.[id];
    return v === "offline" || v === "stale";
  });
  if (flagged.length === 0 || !snapshot) return null;
  return (
    <div className="mt-1 text-[11px] text-faint text-right" data-testid="mention-delivery-meta">
      {flagged.map((id) => (
        <MentionDeliveryMetaItem key={id} actorId={id} state={snapshot[id] as "offline" | "stale"} t={t} />
      ))}
    </div>
  );
}

function MentionDeliveryMetaItem({
  actorId,
  state,
  t,
}: {
  actorId: string;
  state: "offline" | "stale";
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const name = useActorDisplayName(actorId);
  const label =
    state === "stale"
      ? t("chat.sessionAgent.metaStale", { name: name || actorId })
      : t("chat.sessionAgent.metaOffline", { name: name || actorId });
  return <div>{label}</div>;
}

function RemoteAttachmentChip({
  filename,
  remoteUrl,
  parentDir,
  size,
}: {
  filename: string;
  remoteUrl: string;
  parentDir?: string;
  size?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState(false);
  const urlKey = React.useMemo(() => normalizeAttachmentUrlKey(remoteUrl), [remoteUrl]);
  const hasSavedCopy = isTauri() && Boolean(getCachedAttachmentPath(urlKey));
  const actionTitle = hasSavedCopy
    ? t("fileExplorer.revealInFinder", "Reveal in Finder")
    : t("chat.attachment.download", "Download attachment");

  const handleClick = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openOrDownloadRemoteAttachment(remoteUrl, filename);
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
      onClick={() => void handleClick()}
      disabled={busy}
      title={actionTitle}
      className="inline-flex items-center gap-1.5 px-2 py-1.5 mx-0.5 rounded-md text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 min-w-0 max-w-[280px] cursor-pointer hover:bg-orange-200/80 dark:hover:bg-orange-900/60 disabled:opacity-60"
    >
      <Paperclip className="h-3 w-3 flex-shrink-0" />
      <span className="flex flex-col min-w-0 text-left">
        <span className="truncate font-medium leading-tight">{filename}</span>
        {parentDir && (
          <span className="truncate text-[10px] opacity-60 leading-tight">{parentDir}</span>
        )}
      </span>
      {size && (
        <span className="text-orange-500 dark:text-orange-400 flex-shrink-0 ml-0.5">{size}</span>
      )}
    </button>
  );
}

export function UserMessageWithMentions({
  content,
  basePath,
  leadingMentionActorIds = [],
  mentionDeliverySnapshot,
  userBubble = "other",
}: {
  content: string;
  basePath?: string;
  leadingMentionActorIds?: string[];
  mentionDeliverySnapshot?: Record<string, "ready" | "offline" | "stale">;
  /** Matches parent MessageContent skin — collapse fade only. */
  userBubble?: "self" | "other";
}) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [needsCollapse, setNeedsCollapse] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const displayContent = React.useMemo(
    () =>
      content
        .replace(/(?:\r?\n){0,2}First tool call:\s*role_load\(\{\s*name:\s*"[^"]+"\s*\}\)\.\s*/g, "")
        .replace(/(?:\r?\n){0,2}First tool call:\s*skill\(\{\s*name:\s*"[^"]+"\s*\}\)\.\s*/g, "")
        .trim(),
    [content],
  )

  // Measure content height after render to decide whether to collapse
  React.useEffect(() => {
    const el = contentRef.current;
    if (el) {
      // Add a small buffer (20px) so we don't collapse content that's barely over the limit
      setNeedsCollapse(el.scrollHeight > COLLAPSED_HEIGHT + 20);
    }
  }, [displayContent]);

  const { parts, agentMentionNames } = React.useMemo(() => {
    const result: Array<{
      type: "text" | "file" | "directory" | "image" | "mentioned" | "attachment" | "filemention" | "role" | "skill" | "command" | "actorMention" | "pageLink";
      content: string;
      people?: string[];
      mentionKind?: "agent" | "human";
      dataUrl?: string;
      size?: string;
      fullPath?: string;
      remoteUrl?: string;
      pageContext?: PageContext;
      pageUrl?: string;
    }> = [];

    const structured = parseStructuredMentionPrefix(displayContent);
    const agentNames = structured.parts
      .filter((part) => part.mentionKind === "agent")
      .flatMap((part) => part.people);
    for (const part of structured.parts) {
      if (part.mentionKind !== "agent") {
        result.push(part);
      }
    }
    const bodyForTokens = structured.body;

    const useLeadingActorIds =
      leadingMentionActorIds.length > 0 && !hasStructuredMentionLines(displayContent);
    for (const actorId of useLeadingActorIds ? leadingMentionActorIds : []) {
      result.push({ type: "actorMention", content: actorId });
    }
    if (useLeadingActorIds && leadingMentionActorIds.length > 0 && bodyForTokens) {
      result.push({ type: "text", content: " " });
    }

    let lastIndex = 0;
    // Match @{filepath}, unified /{type:name}, legacy /<role> and /[command], [Role: ...], [File: ...], [Skill: ...], [Command: ...], [Attachment: ...], and other formats
    const combinedRegex =
      /@\{([^}]+)\}|\/\{([^}]+)\}|\/<([a-z0-9]+(?:-[a-z0-9]+)*)>|\/\[([^\]]+)\]|\[Mentioned: ([^\]]+)\]|\[Role: ([^\]]+)\]|\[File: ([^\]]+)\](?:\n```[\s\S]*?```)?|\[Skill: ([^\]]+)\]|\[Page: ([^\]]+)\]|\[Command: ([^\]]+)\]|\[Directory: ([^\]]+)\]\s*|\[Image: ([^\]]+)\](?:\n([^\n]*)|\s*\(url:\s*([^)]*)\))?|\[Attachment: ([^\]]+)\]\s*\(([^)]*)\)/g;

    let match;
    while ((match = combinedRegex.exec(bodyForTokens)) !== null) {
      if (match.index > lastIndex) {
        const text = bodyForTokens.slice(lastIndex, match.index);
        if (text) {
          result.push({ type: "text", content: text });
        }
      }

      if (match[1]) {
        const page = parsePageLinkBody(match[1]);
        if (page) {
          result.push({ type: "pageLink", content: "", pageContext: page });
        } else {
          result.push({ type: "filemention", content: match[1] });
        }
      } else if (match[2]) {
        const token = parseSlashToken(match[2]);
        result.push({ type: token.type, content: token.name });
      } else if (match[3]) {
        result.push({ type: "role", content: match[3] });
      } else if (match[4]) {
        // /[commandname] format (for user input display)
        result.push({ type: "command", content: match[4] });
      } else if (match[5]) {
        const raw = match[5];
        if (raw.includes("|instruction:")) {
          const name = stripChipMetadata(raw);
          result.push({
            type: "mentioned",
            content: raw,
            people: name ? [name] : [],
            mentionKind: "human",
          });
        } else {
          const people = raw.split(",").map((p) => p.trim()).filter(Boolean);
          result.push({ type: "mentioned", content: raw, people, mentionKind: "human" });
        }
      } else if (match[6]) {
        result.push({ type: "role", content: stripChipMetadata(match[6]) });
      } else if (match[7]) {
        // [File: filepath] format (sent to LLM)
        result.push({ type: "file", content: match[7] });
      } else if (match[8]) {
        // [Skill: skillname] format (sent to LLM)
        result.push({ type: "skill", content: stripChipMetadata(match[8]) });
      } else if (match[9]) {
        const parsed = parseSentPageChip(match[9]);
        result.push({
          type: "pageLink",
          content: parsed.label,
          pageUrl: parsed.url,
        });
      } else if (match[10]) {
        // [Command: commandname] format (sent to LLM)
        result.push({ type: "command", content: stripChipMetadata(match[10]) });
      } else if (match[11]) {
        result.push({ type: "directory", content: match[11] });
      } else if (match[12]) {
        const inlineDataUrl =
          match[13] && match[13].startsWith("data:") ? match[13] : undefined;
        const remoteUrl = match[14]?.trim();
        const remoteImageUrl =
          remoteUrl &&
          remoteUrl !== "undefined" &&
          (remoteUrl.startsWith("http://") || remoteUrl.startsWith("https://"))
            ? remoteUrl
            : undefined;
        result.push({
          type: "image",
          content: match[12],
          dataUrl: inlineDataUrl ?? remoteImageUrl,
        });
      } else if (match[15]) {
        // Parse the parenthesised info: may contain path:..., url:..., size:...
        const info = match[16] ?? "";
        const pathMatch = info.match(/path:\s*([^,)]+)/);
        const urlMatch = info.match(/url:\s*([^,)]+)/);
        const sizeMatch = info.match(/size:\s*([^,)]+)/);
        const fullPath = pathMatch ? pathMatch[1].trim() : undefined;
        const remoteUrlRaw = urlMatch ? urlMatch[1].trim() : undefined;
        const remoteUrl =
          remoteUrlRaw &&
          remoteUrlRaw !== "undefined" &&
          (remoteUrlRaw.startsWith("http://") || remoteUrlRaw.startsWith("https://"))
            ? remoteUrlRaw
            : undefined;
        const size = sizeMatch ? sizeMatch[1].trim() : (!pathMatch && !urlMatch && info.trim() ? info.trim() : undefined);
        result.push({ type: "attachment", content: match[15], size, fullPath, remoteUrl });
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < bodyForTokens.length) {
      const text = bodyForTokens.slice(lastIndex);
      if (text) {
        result.push({ type: "text", content: text });
      }
    }

    return { parts: result, agentMentionNames: agentNames };
  }, [displayContent, leadingMentionActorIds]);

  const hasAgentHeader = agentMentionNames.length > 0;

  const isSimpleText =
    !hasAgentHeader &&
    leadingMentionActorIds.length === 0 &&
    (parts.length === 0 || (parts.length === 1 && parts[0].type === "text"));

  const renderBodyParts = () =>
    groupUserMessageParts(parts as UserMessagePart[]).map((segment) => {
      if (segment.kind === "imageRow") {
        return (
          <div
            key={`img-row-${segment.index}`}
            className="flex flex-wrap items-center gap-1 my-0.5"
            data-testid="user-message-image-row"
          >
            {segment.parts.map((part, imageIndex) => (
              <span key={`${segment.index}-${imageIndex}`} className="shrink-0">
                {renderUserMessageImage(part, basePath)}
              </span>
            ))}
          </div>
        );
      }

      const { part, index } = segment;
      if (part.type === "text") {
        return <span key={index}>{part.content}</span>;
      }

      if (part.type === "actorMention") {
        return <ActorMentionChip key={index} actorId={part.content} />;
      }

      if (part.type === "mentioned" && part.people) {
        const isAgent = part.mentionKind === "agent";
        return (
          <React.Fragment key={index}>
            {part.people.map((person, personIndex) => {
              const personMatch = person.match(/^(.+?)(?:\s*\(([^)]+)\))?$/);
              const name = personMatch ? personMatch[1] : person;
              const email = personMatch ? personMatch[2] : undefined;

              if (!isAgent) {
                return (
                  <HumanMentionChip
                    key={personIndex}
                    name={name}
                    title={email}
                  />
                );
              }

              return (
                <span
                  key={personIndex}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-1 mx-0.5 rounded-md text-xs",
                    "bg-[#edf2f7] text-[#5a7086] dark:bg-[#202a34] dark:text-[#aec3d6]",
                  )}
                >
                  <User className="h-3 w-3" />
                  <span className="truncate max-w-[200px]" title={email}>
                    @{name}
                  </span>
                </span>
              );
            })}
          </React.Fragment>
        );
      }

      if (part.type === "pageLink") {
        const label = part.pageContext ? pageLinkChipLabel(part.pageContext) : part.content;
        const title = part.pageUrl ?? part.pageContext?.url ?? part.content;
        return (
          <span
            key={index}
            title={title}
            className={cn(
              INLINE_CHIP_BASE,
              "bg-[#f5efe8] text-[#6b5a48] dark:bg-[#2e2922] dark:text-[#d3c5ac]",
            )}
          >
            <Link2 className="h-3 w-3" />
            <span className="truncate max-w-[320px]">{label}</span>
          </span>
        );
      }

      if (part.type === "attachment") {
        const parentDir = part.fullPath
          ? part.fullPath.replace(/\\/g, "/").split("/").slice(-2, -1)[0]
          : undefined;
        const chip = (
          <>
            <Paperclip className="h-3 w-3 flex-shrink-0" />
            <span className="flex flex-col min-w-0">
              <span className="truncate font-medium leading-tight">{part.content}</span>
              {parentDir && (
                <span className="truncate text-[10px] opacity-60 leading-tight">{parentDir}</span>
              )}
            </span>
            {part.size && (
              <span className="text-orange-500 dark:text-orange-400 flex-shrink-0 ml-0.5">{part.size}</span>
            )}
          </>
        );
        if (part.remoteUrl) {
          return (
            <RemoteAttachmentChip
              key={index}
              filename={part.content}
              remoteUrl={part.remoteUrl}
              parentDir={parentDir}
              size={part.size}
            />
          );
        }
        return (
          <span
            key={index}
            title={part.fullPath ?? part.content}
            className="inline-flex items-center gap-1.5 px-2 py-1.5 mx-0.5 rounded-md text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 min-w-0 max-w-[280px]"
          >
            {chip}
          </span>
        );
      }

      return (
        <span
          key={index}
          className={cn(
            INLINE_CHIP_BASE,
            (part.type === "file" || part.type === "filemention") && "bg-[#edf2f7] text-[#5a7086] dark:bg-[#202a34] dark:text-[#aec3d6]",
            part.type === "directory" && "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
            part.type === "role" && "bg-[#eef3f5] text-[#5b7080] dark:bg-[#222d33] dark:text-[#b8cad3]",
            part.type === "skill" && "bg-[#f3efe6] text-[#7a6a52] dark:bg-[#302b22] dark:text-[#d3c5ac]",
            part.type === "command" && "bg-[#f1ebf3] text-[#75607c] dark:bg-[#2f2632] dark:text-[#ccbcd2]",
          )}
        >
          {(part.type === "file" || part.type === "filemention") && <FileText className="h-3 w-3" />}
          {part.type === "directory" && <Folder className="h-3 w-3" />}
          {part.type === "role" && <UserRound className="h-3 w-3" />}
          {part.type === "skill" && <Zap className="h-3 w-3" />}
          {part.type === "command" && <CommandIcon className="h-3 w-3" />}
          <span className="truncate max-w-[320px]" title={part.content}>
            {part.type === "file" || part.type === "filemention"
              ? getTrailingPathLabel(part.content)
              : part.content}
          </span>
        </span>
      );
    });

  // Build the inner content - render parts in order
  const innerContent = isSimpleText ? (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{displayContent}</div>
  ) : (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {hasAgentHeader ? <AgentMentionHeader names={agentMentionNames} /> : null}
      {renderBodyParts()}
    </div>
  );

  const isCollapsed = needsCollapse && !isExpanded;

  const isSelfBubble = userBubble === "self";
  const collapseFadeClass = isSelfBubble
    ? "from-[#e8edf2] dark:from-white/[0.20]"
    : "from-paper dark:from-paper";

  return (
    <div>
      {/* Content container with optional max-height clipping */}
      <div
        ref={contentRef}
        className="relative"
        style={
          isCollapsed
            ? { maxHeight: COLLAPSED_HEIGHT, overflow: "hidden" }
            : undefined
        }
      >
        {innerContent}

        {/* Gradient fade overlay when collapsed — matches the bubble bg color */}
        {isCollapsed && (
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 h-16 pointer-events-none bg-gradient-to-t to-transparent",
              collapseFadeClass,
            )}
          />
        )}
      </div>

      {/* Expand / collapse toggle */}
      <MentionDeliveryMetaLine
        actorIds={leadingMentionActorIds}
        snapshot={mentionDeliverySnapshot}
      />

      {needsCollapse && (
        <button
          onClick={() => setIsExpanded((v) => !v)}
          className="flex items-center gap-1 mt-1.5 text-xs text-[#66727d] hover:text-[#1f2933] dark:text-[#c9d3db] dark:hover:text-[#f5f8fb] transition-colors cursor-pointer"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              <span>{t("chat.showLess", "Show less")}</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              <span>{t("chat.showMore", "Show more")}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
