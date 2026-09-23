import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";

import { t } from "../../../lib/i18n";
import { colors, hai, iosType, radii, spacing, typography } from "../../../ui/theme";
import type { FeedbackKind } from "../cloud-api";
import type { MessageAttachment, SessionMessage } from "../session-types";
import { buildThinkingBody, buildThinkingPreview } from "./agent-thinking-presentation";
import { AudioPlayerChip } from "./AudioPlayerChip";
import { ImageLightbox } from "./ImageLightbox";
import { PermissionBanner } from "./PermissionBanner";
import { ToolCallLine } from "./ToolCallLine";
import { toolCallPresentation, type ToolResult } from "../tool-display";

const HIDDEN_MESSAGE_KINDS = new Set<string>([]);

const AGENT_THINKING_KIND = "agent_thinking";

const AGENT_NOTE_KINDS = new Set(["agent_tool_call", "agent_tool_result"]);

/** iOS bubbles are `RoundedRectangle(cornerRadius: 18)` on every variant. */
const BUBBLE_RADIUS = 18;

export type SessionMessageRowProps = {
  message: SessionMessage;
  isOwnMessage?: boolean;
  onDelete?: (messageId: string) => void;
  onEdit?: (message: SessionMessage) => void;
  onJumpToReply?: (messageId: string) => void;
  onReply?: (message: SessionMessage) => void;
  /** Click handler for the trailing outbox dot when the row is in `failed` state. */
  onRetryOutbox?: (messageId: string) => void;
  /** Outbox lifecycle for this row's user_prompt — mirrors iOS OutboxStatusDot states. */
  outboxStatus?: "sending" | "sent" | "failed";
  onGrantPermission?: (requestId: string, message: SessionMessage) => void;
  onDenyPermission?: (requestId: string, message: SessionMessage) => void;
  /** When set, marks a permission request row as resolved with the given decision. */
  resolvedPermission?: { granted: boolean } | null;
  replyToMessage?: SessionMessage | null;
  senderName?: string;
  /** When true, appends a blinking cursor to indicate live streaming. */
  isStreaming?: boolean;
  /**
   * The `agent_tool_result` that answered this `agent_tool_call`, folded in by
   * `foldToolResults`. Absent means the tool is still running.
   */
  toolResult?: ToolResult;
  /** The signed-in member's feedback on this agent reply, if any. */
  feedbackKind?: FeedbackKind | null;
  /** Thumbs on agent replies — iOS `CompletedTurnBubbleView.onFeedback`. */
  onFeedback?: (kind: FeedbackKind) => void;
};

export function normalizeBody(message: SessionMessage): string {
  const body = message.content.trim();
  if (!body) {
    return t("(empty message)");
  }
  return body;
}

export function isHiddenMessageKind(kind: string): boolean {
  return HIDDEN_MESSAGE_KINDS.has(kind.trim().toLowerCase());
}

export function isAgentNoteKind(kind: string): boolean {
  return AGENT_NOTE_KINDS.has(kind.trim().toLowerCase());
}

export function isAgentThinkingKind(kind: string): boolean {
  return kind.trim().toLowerCase() === AGENT_THINKING_KIND;
}

/**
 * Eyebrow + tone palette for tool note message kinds. Mirrors the iOS
 * `StreamingDetailView` styling: tool calls/results use Pebble + Basalt
 * mono labels. Sage and cinnabar are reserved for the chip bar.
 */
function agentNoteStyle(kind: string): { eyebrow: string; tint: string } {
  const lower = kind.trim().toLowerCase();
  if (lower === "agent_tool_call") {
    return { eyebrow: t("TOOL CALL"), tint: hai.basalt };
  }
  if (lower === "agent_tool_result") {
    return { eyebrow: t("TOOL RESULT"), tint: hai.basalt };
  }
  return { eyebrow: t("TOOL"), tint: hai.basalt };
}

export function formatTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SessionMessageRow({
  message,
  isOwnMessage = false,
  onDelete,
  onEdit,
  onJumpToReply,
  onReply,
  onRetryOutbox,
  outboxStatus,
  onGrantPermission,
  onDenyPermission,
  resolvedPermission,
  replyToMessage,
  senderName,
  isStreaming = false,
  toolResult,
  feedbackKind = null,
  onFeedback,
}: SessionMessageRowProps) {
  const { t: tHook } = useTranslation();
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [noteExpanded, setNoteExpanded] = useState(false);

  const cursorOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isStreaming) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(cursorOpacity, { toValue: 0.2, duration: 300, useNativeDriver: true }),
        Animated.timing(cursorOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isStreaming, cursorOpacity]);
  const kindKey = message.kind.trim().toLowerCase();
  if (isHiddenMessageKind(kindKey)) return null;

  const timestamp = formatTimestamp(message.createdAt);

  const handleLongPress = () => {
    type Action = {
      label: string;
      style?: "default" | "cancel" | "destructive";
      run?: () => void;
    };
    // iOS puts a confirmationDialog behind Delete, and its message is the whole
    // reason: "the message is removed for everyone in this session." Deleting
    // from a chat usually means removing your own copy, and this does not.
    const confirmDelete = () => {
      if (!onDelete) return;
      const run = () => onDelete(message.messageId);
      const title = tHook("Delete this message?");
      const body = tHook("The message is removed for everyone in this session.");
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title,
            message: body,
            options: [tHook("Delete"), tHook("Cancel")],
            cancelButtonIndex: 1,
            destructiveButtonIndex: 0,
          },
          (index) => {
            if (index === 0) run();
          },
        );
        return;
      }
      Alert.alert(title, body, [
        { text: tHook("Delete"), style: "destructive", onPress: run },
        { text: tHook("Cancel"), style: "cancel" },
      ]);
    };

    const actions: Action[] = [
      {
        label: tHook("Copy"),
        run: () => {
          void Clipboard.setStringAsync(message.content);
        },
      },
    ];
    if (onReply) {
      actions.push({ label: tHook("Reply"), run: () => onReply(message) });
    }
    if (isOwnMessage && onEdit) {
      actions.push({ label: tHook("Edit"), run: () => onEdit(message) });
    }
    if (isOwnMessage && onDelete) {
      actions.push({
        label: tHook("Delete"),
        style: "destructive",
        run: () => confirmDelete(),
      });
    }
    actions.push({ label: tHook("Cancel"), style: "cancel" });

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: actions.map((a) => a.label),
          cancelButtonIndex: actions.length - 1,
          destructiveButtonIndex: actions.findIndex(
            (a) => a.style === "destructive",
          ),
        },
        (index) => {
          const action = actions[index];
          if (action?.run) action.run();
        },
      );
      return;
    }
    Alert.alert(
      tHook("Message"),
      message.content.slice(0, 80),
      actions.map((a) => ({
        text: a.label,
        style: a.style,
        onPress: a.run,
      })),
    );
  };

  if (kindKey === "permission_request") {
    const metadata =
      message.metadata && typeof message.metadata === "object"
        ? (message.metadata as Record<string, unknown>)
        : {};
    const toolName =
      typeof metadata.tool_name === "string" && metadata.tool_name.trim().length > 0
        ? (metadata.tool_name as string)
        : typeof metadata.toolName === "string"
          ? (metadata.toolName as string)
          : "";
    const requestId =
      (typeof metadata.tool_id === "string" && (metadata.tool_id as string)) ||
      (typeof metadata.request_id === "string" && (metadata.request_id as string)) ||
      message.messageId;
    return (
      <View style={[styles.row, styles.rowOther, styles.permissionRowContainer]}>
        <PermissionBanner
          description={message.content.trim()}
          isResolved={resolvedPermission !== null && resolvedPermission !== undefined}
          onDeny={onDenyPermission ? (id) => onDenyPermission(id, message) : undefined}
          onGrant={onGrantPermission ? (id) => onGrantPermission(id, message) : undefined}
          requestId={requestId}
          toolName={toolName}
          wasGranted={resolvedPermission?.granted ?? null}
        />
      </View>
    );
  }

  if (isAgentThinkingKind(kindKey)) {
    const body = buildThinkingBody(message.content);
    const preview = buildThinkingPreview(message.content);
    return (
      <View style={[styles.row, styles.thinkingRow, styles.rowOther]}>
        <View style={styles.thinkingGutter} />
        <Pressable
          accessibilityHint={tHook("Tap to expand")}
          accessibilityRole="button"
          onPress={() => setNoteExpanded((value) => !value)}
          style={({ pressed }) => [
            styles.thinkingSurface,
            pressed ? styles.surfacePressed : null,
          ]}
        >
          <View style={styles.thinkingHeaderRow}>
            <View style={styles.thinkingTitleRow}>
              <Ionicons
                color={colors.slate}
                name={noteExpanded ? "chevron-down" : "chevron-forward"}
                size={12}
              />
              <Ionicons color={colors.slate} name="sparkles-outline" size={13} />
              <Text style={styles.thinkingLabel}>{tHook("Thinking")}</Text>
              {!noteExpanded ? (
                <Text numberOfLines={1} style={styles.thinkingPreview}>
                  {preview}
                </Text>
              ) : null}
            </View>
            {timestamp ? <Text style={styles.thinkingTime}>{timestamp}</Text> : null}
          </View>
          {noteExpanded ? (
            <View style={styles.thinkingExpanded}>
              <Text style={styles.thinkingExpandedText}>{body}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>
    );
  }

  if (kindKey === "agent_tool_call") {
    return (
      <ToolCallLine
        presentation={toolCallPresentation(message, toolResult)}
        result={toolResult}
        timestamp={timestamp}
      />
    );
  }

  // A tool result that reached here is an orphan — `foldToolResults` folds the
  // ones whose call is in the timeline into that call's row. Keep the note card
  // for it rather than dropping the information on the floor.
  if (isAgentNoteKind(kindKey)) {
    const note = agentNoteStyle(kindKey);
    const noteBody = normalizeBody(message);
    return (
      <View style={[styles.row, styles.rowOther]}>
        <Pressable
          accessibilityHint={tHook("Tap to expand")}
          accessibilityRole="button"
          onPress={() => setNoteExpanded((value) => !value)}
          style={({ pressed }) => [
            styles.surface,
            styles.surfaceNote,
            pressed ? styles.surfacePressed : null,
          ]}
        >
          <View style={styles.noteHeaderRow}>
            <Text style={[styles.noteEyebrow, { color: note.tint }]}>{note.eyebrow}</Text>
            <Ionicons
              color={note.tint}
              name={noteExpanded ? "chevron-up" : "chevron-down"}
              size={12}
            />
          </View>
          <Text
            numberOfLines={noteExpanded ? undefined : 3}
            style={styles.noteBody}
          >
            {noteBody}
          </Text>
          {timestamp ? <Text style={styles.noteTime}>{timestamp}</Text> : null}
        </Pressable>
      </View>
    );
  }

  const body = normalizeBody(message);
  const attachments = message.attachments ?? [];
  // iOS splits three bubble shapes, not two: the user's own prompt, another
  // human's prompt, and an assistant reply. Only the third one runs full-bleed
  // and carries the "{Agent} · {Model}" caption.
  const isAgentReply = !isOwnMessage && message.kind.trim().toLowerCase() === "agent_reply";
  const captionLabel = isOwnMessage
    ? tHook("You")
    : isAgentReply
      ? [senderName, message.model].filter(Boolean).join(" · ")
      : senderName ?? "";

  return (
    <View style={[styles.row, isOwnMessage ? styles.rowOwn : styles.rowOther]}>
      {/* iOS puts identity in a caption above the bubble, not inside it, and
          not in bold — `EventBubbleView.selfUserBubble` / `otherUserBubble`. */}
      {captionLabel ? (
        <Text
          numberOfLines={1}
          style={[
            styles.senderName,
            isOwnMessage ? styles.senderNameOwn : styles.senderNameOther,
          ]}
        >
          {captionLabel}
        </Text>
      ) : null}
      <Pressable
        accessibilityHint={tHook("Long-press to copy or delete")}
        delayLongPress={350}
        onLongPress={handleLongPress}
        style={({ pressed }) => [
          styles.surface,
          isAgentReply ? styles.surfaceAgent : styles.surfaceBounded,
          isOwnMessage ? styles.surfaceOwn : styles.surfaceOther,
          pressed ? styles.surfacePressed : null,
        ]}
      >

        {replyToMessage ? (
          <Pressable
            accessibilityRole={onJumpToReply ? "button" : undefined}
            onPress={
              onJumpToReply
                ? () => onJumpToReply(replyToMessage.messageId)
                : undefined
            }
            style={({ pressed }) => [
              styles.replyContext,
              isOwnMessage ? styles.replyContextOwn : styles.replyContextOther,
              pressed && onJumpToReply ? styles.surfacePressed : null,
            ]}
          >
            <View
              style={[
                styles.replyAccent,
                isOwnMessage ? styles.replyAccentOwn : styles.replyAccentOther,
              ]}
            />
            <Text
              numberOfLines={2}
              style={[
                styles.replyBody,
                isOwnMessage ? styles.replyBodyOwn : styles.replyBodyOther,
              ]}
            >
              {replyToMessage.content || tHook("(empty message)")}
            </Text>
          </Pressable>
        ) : null}

        {attachments.length > 0 ? (
          <View style={styles.attachmentList}>
            {attachments.map((attachment, index) => (
              <AttachmentChip
                attachment={attachment}
                isOwn={isOwnMessage}
                key={`${attachment.url}:${index}`}
                onOpenImage={(url) => setLightboxUrl(url)}
              />
            ))}
          </View>
        ) : null}
        <ImageLightbox onClose={() => setLightboxUrl(null)} url={lightboxUrl} />

        {body.length > 0 ? (
          <Markdown
            style={isOwnMessage ? ownMarkdown : otherMarkdown}
          >
            {body}
          </Markdown>
        ) : null}

        {isStreaming ? (
          <Animated.Text
            style={[
              styles.body,
              isOwnMessage ? styles.bodyOwn : styles.bodyOther,
              { opacity: cursorOpacity },
            ]}
          >
            {" ▌"}
          </Animated.Text>
        ) : null}

        <View style={styles.footerRow}>
          {isAgentReply && onFeedback && !isStreaming ? (
            <View style={styles.feedbackGroup}>
              {(["positive", "negative"] as const).map((kind) => {
                const active = feedbackKind === kind;
                const icon = kind === "positive" ? "thumbs-up" : "thumbs-down";
                return (
                  <Pressable
                    accessibilityLabel={kind === "positive" ? tHook("Helpful") : tHook("Not Helpful")}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    hitSlop={8}
                    key={kind}
                    onPress={() => onFeedback(kind)}
                  >
                    <Ionicons
                      color={active ? hai.cinnabar : colors.slate}
                      name={active ? icon : `${icon}-outline`}
                      size={13}
                    />
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {timestamp ? (
            <Text
              style={[styles.time, isOwnMessage ? styles.timeOwn : styles.timeOther]}
            >
              {timestamp}
            </Text>
          ) : null}
          {isOwnMessage && outboxStatus ? (
            <OutboxStatusDot
              messageId={message.messageId}
              onRetry={onRetryOutbox}
              status={outboxStatus}
            />
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

function OutboxStatusDot({
  messageId,
  onRetry,
  status,
}: {
  messageId: string;
  onRetry?: (messageId: string) => void;
  status: "sending" | "sent" | "failed";
}) {
  if (status === "sending") {
    return (
      <Ionicons
        accessibilityLabel={t("Sending")}
        color={colors.basalt}
        name="ellipsis-horizontal"
        size={12}
        style={styles.outboxDot}
      />
    );
  }
  if (status === "sent") {
    return (
      <Ionicons
        accessibilityLabel={t("Delivered")}
        color={colors.slate}
        name="checkmark"
        size={12}
        style={styles.outboxDot}
      />
    );
  }
  if (status === "failed") {
    return (
      <Pressable
        accessibilityLabel={t("Retry sending message")}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onRetry ? () => onRetry(messageId) : undefined}
      >
        <Ionicons
          color={colors.cinnabarDeep}
          name="alert-circle"
          size={14}
          style={styles.outboxDot}
        />
      </Pressable>
    );
  }
  return null;
}

function AttachmentChip({
  attachment,
  isOwn,
  onOpenImage,
}: {
  attachment: MessageAttachment;
  isOwn: boolean;
  onOpenImage?: (url: string) => void;
}) {
  const mime = attachment.mime ?? "";
  if (mime.startsWith("image/")) {
    return (
      <Pressable
        accessibilityRole="image"
        onPress={onOpenImage ? () => onOpenImage(attachment.url) : undefined}
      >
        <Image
          resizeMode="cover"
          source={{ uri: attachment.url }}
          style={styles.attachmentImage}
        />
      </Pressable>
    );
  }
  if (mime.startsWith("audio/")) {
    return <AudioPlayerChip isOwn={isOwn} url={attachment.url} />;
  }
  const label = attachment.path?.split("/").pop() ?? (mime || t("Attachment"));
  return (
    <View
      style={[
        styles.attachmentPill,
        isOwn ? styles.attachmentPillOwn : styles.attachmentPillOther,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.attachmentLabel, isOwn ? styles.attachmentLabelOwn : null]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Markdown styling for the two bubble variants.
 *
 * `fence` is not optional decoration: react-native-markdown-display routes
 * ```-fenced blocks through it and indented blocks through `code_block`, and
 * agents emit fenced code almost exclusively. Styling only `code_block` left
 * the common case on the library's defaults.
 *
 * Same reason the blockquote and table rules are here. Their defaults are
 * hardcoded `#F5F5F5` / `#CCC` / `#000000`, which are off-palette everywhere
 * and unreadable inside the dark own-message bubble.
 */
const OWN_SURFACE = "rgba(248,246,241,0.18)";

const ownMarkdown = {
  body: { color: hai.mist, ...iosType.subheadline, marginBottom: 0, marginTop: 0 },
  code_inline: {
    backgroundColor: OWN_SURFACE,
    borderRadius: 4,
    color: hai.mist,
    paddingHorizontal: 4,
  },
  code_block: {
    backgroundColor: OWN_SURFACE,
    borderRadius: 6,
    color: hai.mist,
    padding: 8,
  },
  fence: {
    backgroundColor: OWN_SURFACE,
    borderRadius: 6,
    color: hai.mist,
    padding: 8,
  },
  blockquote: {
    backgroundColor: OWN_SURFACE,
    borderColor: "rgba(248,246,241,0.45)",
    borderLeftWidth: 3,
    marginLeft: 0,
    paddingHorizontal: 8,
  },
  table: {
    borderColor: "rgba(248,246,241,0.35)",
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "rgba(248,246,241,0.35)" },
  th: { color: hai.mist, padding: 6 },
  td: { color: hai.mist, padding: 6 },
  link: { color: hai.mist, textDecorationLine: "underline" as const },
  paragraph: { color: hai.mist, marginBottom: 0, marginTop: 0 },
};

const otherMarkdown = {
  body: { color: hai.onyx, ...iosType.subheadline, marginBottom: 0, marginTop: 0 },
  code_inline: {
    backgroundColor: hai.pebble,
    borderRadius: 4,
    color: hai.onyx,
    paddingHorizontal: 4,
  },
  code_block: {
    backgroundColor: hai.pebble,
    borderRadius: 6,
    color: hai.onyx,
    padding: 8,
  },
  fence: {
    backgroundColor: hai.pebble,
    borderRadius: 6,
    color: hai.onyx,
    padding: 8,
  },
  blockquote: {
    backgroundColor: hai.pebble,
    borderColor: hai.slate,
    borderLeftWidth: 3,
    marginLeft: 0,
    paddingHorizontal: 8,
  },
  table: {
    borderColor: hai.hairline,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: hai.hairline },
  th: { color: hai.onyx, padding: 6 },
  td: { color: hai.onyx, padding: 6 },
  link: { color: hai.cinnabar, textDecorationLine: "underline" as const },
  paragraph: { color: hai.onyx, marginBottom: 0, marginTop: 0 },
};

const styles = StyleSheet.create({
  attachmentImage: {
    backgroundColor: hai.pebble,
    borderRadius: 10,
    height: 180,
    width: 220,
  },
  attachmentLabel: {
    color: hai.onyx,
    ...typography.caption,
    fontWeight: "600",
  },
  attachmentLabelOwn: {
    color: hai.paper,
  },
  attachmentList: {
    gap: 6,
  },
  attachmentPill: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  attachmentPillOther: {
    backgroundColor: hai.pebble,
  },
  attachmentPillOwn: {
    backgroundColor: "rgba(248,246,241,0.18)",
  },
  body: {
    ...iosType.subheadline,
  },
  bodyOther: {
    color: colors.onyx,
  },
  bodyOwn: {
    color: colors.mist,
  },
  row: {
    gap: 2,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    width: "100%",
  },
  rowOther: {
    alignItems: "flex-start",
  },
  rowOwn: {
    alignItems: "flex-end",
  },
  surface: {
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  /* iOS caps user bubbles at 260pt in the compact size class; assistant
     replies run to the full column width instead. */
  surfaceBounded: {
    maxWidth: 260,
  },
  surfaceAgent: {
    alignSelf: "stretch",
  },
  surfaceOther: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: BUBBLE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noteBody: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  noteEyebrow: {
    ...typography.eyebrow,
    fontWeight: "700",
  },
  noteHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "space-between",
  },
  noteTime: {
    alignSelf: "flex-end",
    color: colors.slate,
    ...typography.monoMeta,
    fontSize: 10,
  },
  surfaceNote: {
    backgroundColor: hai.pebble,
    borderRadius: radii.card,
    gap: 4,
    maxWidth: "92%",
  },
  thinkingExpanded: {
    backgroundColor: "rgba(248,246,241,0.68)",
    borderColor: colors.hairline,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  thinkingExpandedText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  thinkingGutter: {
    width: 24,
  },
  /* The bubble row stacks its caption above the bubble; the thinking block
     instead indents sideways behind a gutter, so it opts back into a row. */
  thinkingRow: {
    flexDirection: "row",
  },
  thinkingHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  thinkingLabel: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  thinkingPreview: {
    color: colors.slate,
    flex: 1,
    ...typography.caption,
  },
  thinkingSurface: {
    backgroundColor: "rgba(248,246,241,0.82)",
    borderColor: colors.borderSoft,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    maxWidth: "82%",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  thinkingTime: {
    color: colors.slate,
    flexShrink: 0,
    ...typography.monoMeta,
    fontSize: 10,
  },
  thinkingTitleRow: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 5,
    minWidth: 0,
  },
  /* Cinnabar, not Onyx: iOS tints the user's own glass with the accent and
     sets the text in Mist. Without a blur to sit behind, the tint becomes the
     fill. */
  surfaceOwn: {
    backgroundColor: colors.cinnabar,
    borderRadius: BUBBLE_RADIUS,
  },
  replyAccent: {
    borderRadius: 2,
    width: 3,
  },
  replyAccentOther: {
    backgroundColor: hai.cinnabar,
  },
  replyAccentOwn: {
    backgroundColor: hai.paper,
  },
  replyBody: {
    flex: 1,
    ...typography.caption,
  },
  replyBodyOther: {
    color: colors.basalt,
  },
  replyBodyOwn: {
    color: "rgba(248,246,241,0.85)",
  },
  replyContext: {
    alignSelf: "stretch",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  replyContextOther: {
    backgroundColor: hai.pebble,
  },
  replyContextOwn: {
    backgroundColor: "rgba(248,246,241,0.12)",
  },
  senderName: {
    color: colors.basalt,
    marginBottom: 2,
    ...iosType.caption,
  },
  senderNameOther: {
    paddingLeft: 4,
  },
  senderNameOwn: {
    paddingRight: 4,
  },
  surfacePressed: {
    opacity: 0.88,
  },
  time: {
    flexShrink: 0,
    ...typography.monoMeta,
    fontSize: 10,
  },
  timeOther: {
    color: colors.slate,
  },
  timeOwn: {
    color: "rgba(248,246,241,0.6)",
  },
  footerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "flex-end",
  },
  feedbackGroup: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginRight: "auto",
  },
  outboxDot: {
    marginLeft: 2,
  },
  permissionRowContainer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
});

export default SessionMessageRow;
