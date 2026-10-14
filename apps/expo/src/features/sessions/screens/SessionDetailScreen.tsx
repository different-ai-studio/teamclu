import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { initialWindowMetrics, useSafeAreaInsets } from "react-native-safe-area-context";

import { Hairline } from "../../../ui/atoms/Hairline";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, spacing, typography } from "../../../ui/theme";
import {
  AgentChipBar,
  type AgentChip,
} from "../components/AgentChipBar";
import { ConnectionBannerOverlay } from "../components/ConnectionBannerOverlay";
import { DaySeparator } from "../components/DaySeparator";
import { buildThinkingPreview } from "../components/agent-thinking-presentation";
import { dayLabel, isSameCalendarDay } from "../components/day-separator-labels";
import { MentionsPopup } from "../components/MentionsPopup";
import {
  applyMention,
  filterMentionCandidates,
  mentionQuery,
  type MentionTarget,
} from "../components/mentions";
import { SessionComposerShell } from "../components/SessionComposerShell";
import { SessionMessageRow } from "../components/SessionMessageRow";
import { SessionPlansPanel } from "../components/SessionPlansPanel";
import {
  getOutboxSnapshot,
  subscribeOutbox,
  type OutboxStatus,
} from "../outbox-store";
import {
  getPendingAttachmentSnapshot,
  removePendingAttachment,
  subscribePendingAttachments,
} from "../pending-attachments";
import {
  deriveAgentPlanSnapshots,
  type AgentPlanSnapshot,
} from "../plan-snapshot";
import { SlashCommandsPopup } from "../components/SlashCommandsPopup";
import {
  filterSlashCommands,
  BUILT_IN_SLASH_COMMANDS,
  slashPrefix,
  type SlashCommand,
} from "../components/slash-commands";
import { TodoDock } from "../components/TodoDock";
import type { FeedbackKind } from "../cloud-api";
import type {
  SessionDetailConnectionState,
  SessionDetailControllerState,
} from "../session-detail-controller";
import {
  buildSessionFeedSources,
  feedKeyContainingMessageId,
  type AgentTurnFeedItem,
  type SessionFeedSource,
} from "../session-feed-items";
import { foldToolResults } from "../tool-display";
import { TurnDetailScreen } from "./TurnDetailScreen";
import {
  feedTailStartIndex,
  isFeedNearBottom,
  shouldAutoScrollForNewFeedItem,
  shouldAutoScrollFeed,
  shouldLoadOlderOnStartReached,
} from "../session-feed-scroll";
import {
  FIRST_UNREAD_THRESHOLD,
  formatNewMessageCount,
  getReadPosition,
  positionOnLeave,
  saveReadPosition,
  unreadSince,
  type ReadPositionRow,
} from "../session-read-position";
import type { SessionMessage, SessionSummary } from "../session-types";
import { impactLight, selectionTick, successTone } from "../../../lib/haptics";
import { showActionSheet, type SheetAction } from "../../../ui/action-sheet";
import { showToast } from "../../../ui/Toast";
import { MessageSelectionBar } from "../components/MessageSelectionBar";
import { SessionSearchBar } from "../components/SessionSearchBar";
import {
  canDeleteSelection,
  composeTranscript,
  displayText,
  feedSearchMatches,
  promptForTurn,
  selectableMessage,
  selectedMessages,
} from "../message-actions";
import { markChatMetric, measureChatMetric } from "../../../lib/telemetry/chat-metrics";
import type { PendingAcpQuestion } from "../pending-questions";
import { AcpQuestionCard } from "../components/AcpQuestionCard";
import { SheetModal } from "../../../ui/SheetModal";
import { t } from "../../../lib/i18n";

type SessionDetailRenderableState = SessionDetailControllerState & {
  status: "empty" | "ready" | "error";
  session: SessionSummary;
};

type SessionDetailScreenProps = {
  agentChips?: AgentChip[];
  composerText: string;
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  isSending: boolean;
  onChangeRuntimeModel?: () => void;
  runtimeInfo?: { status: string; currentModel: string | null } | null;
  isMuted?: boolean;
  mentionPool?: ReadonlyArray<MentionTarget>;
  onAgentInterrupt?: (agentId: string) => void;
  onAgentRemove?: (agentId: string) => void;
  /** The member's own feedback on agent replies, by message id. */
  feedbackByMessageId?: ReadonlyMap<string, FeedbackKind>;
  onFeedback?: (messageId: string, kind: FeedbackKind) => void;
  onAttach?: () => void;
  onBack: () => void;
  onChangeComposerText: (value: string) => void;
  /** "Ask again" on an agent reply: resend the turn's prompt to that agent. */
  onAskAgain?: (input: { content: string; replyToMessageId: string | null; agentId: string }) => void;
  /** Multi-select "Forward": the route picks the target session. */
  onForwardText?: (text: string) => void;
  /** Multi-select "Delete" (own, persisted messages only). */
  onDeleteMessages?: (messageIds: string[]) => void;
  /**
   * A message to scroll to and highlight on open — the one a tapped push was
   * about. Older pages are pulled until it turns up.
   */
  focusMessageId?: string;
  isRefreshing?: boolean;
  onClearReply?: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string, currentContent: string) => void;
  onGrantPermission?: (requestId: string, message: SessionMessage) => void;
  onDenyPermission?: (requestId: string, message: SessionMessage) => void;
  /** Pull the page of history before the oldest message on screen. */
  onLoadOlder?: () => void;
  resolvedPermissionsByRequestId?: ReadonlyMap<string, boolean>;
  onReconnect?: () => void;
  onRefresh?: () => void;
  onOpenMembers?: () => void;
  /** Backfill a turn's daemon-recorded events when its detail is opened. */
  onRequestTurnHistory?: (turnId: string, agentId: string) => void;
  /**
   * A finished turn's recorded trace, by daemon turn id (iOS #1499). When
   * present it replaces what this device streamed: it is the whole turn.
   */
  traceEventsByTurnId?: ReadonlyMap<string, SessionMessage[]>;
  onRetryFailed?: (messageId: string) => void;
  onReplyToMessage?: (messageId: string) => void;
  onSend: () => void;
  onShare?: () => void;
  onToggleMute?: () => void;
  /** Per-session, this device only — grant allow-once requests automatically. */
  autoApprove?: boolean;
  onToggleAutoApprove?: () => void;
  /** Oldest unanswered opencode question; replaces the composer while set. */
  pendingQuestion?: PendingAcpQuestion | null;
  isAnsweringQuestion?: boolean;
  questionErrorMessage?: string | null;
  onAnswerQuestion?: (question: PendingAcpQuestion, answers: string[][]) => void;
  onSkipQuestion?: (question: PendingAcpQuestion) => void;
  ownActorId?: string;
  replyTarget?: { messageId: string; content: string } | null;
  senderAvatars?: ReadonlyMap<string, string | null>;
  /** Optional override for per-actor avatar glyph (e.g. CC/OC/CX). */
  senderAvatarGlyphs?: ReadonlyMap<string, string>;
  senderNames?: ReadonlyMap<string, string>;
  sendErrorMessage: string | null;
  slashCommands?: readonly SlashCommand[];
  state: SessionDetailRenderableState;
  streamingAgentIds?: ReadonlySet<string>;
  todoText?: string;
};

function runtimeStatusKind(
  status: string,
): "active" | "working" | "idle" | "error" | "muted" {
  switch (status.trim().toLowerCase()) {
    case "ready":
    case "idle":
      return "active";
    case "running":
    case "streaming":
      return "working";
    case "spawning":
    case "starting":
      return "idle";
    case "error":
    case "failed":
      return "error";
    case "stopped":
    case "exited":
      return "muted";
    default:
      return "idle";
  }
}

function connectionDescriptor(
  state: SessionDetailConnectionState,
): { dot: "active" | "idle" | "error"; label: string } {
  switch (state) {
    case "connected":
      return { dot: "active", label: t("Live") };
    case "connecting":
      return { dot: "idle", label: t("Connecting") };
    case "disconnected":
    default:
      return { dot: "error", label: t("Offline") };
  }
}

function SessionHeader({
  connectionState,
  headerAvatars,
  isMuted,
  onBack,
  onOpenMembers,
  onShare,
  onSearch,
  onTogglePlans,
  plansPanelOpen,
  onToggleMute,
  autoApprove,
  onToggleAutoApprove,
  session,
}: {
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  isMuted?: boolean;
  onBack: () => void;
  onOpenMembers?: () => void;
  onShare?: () => void;
  onSearch?: () => void;
  onTogglePlans?: () => void;
  plansPanelOpen?: boolean;
  onToggleMute?: () => void;
  autoApprove?: boolean;
  onToggleAutoApprove?: () => void;
  session: SessionSummary;
}) {
  const { t: tHook } = useTranslation();
  const title = session.title.trim() || tHook("Untitled session");
  const status = connectionDescriptor(connectionState);

  return (
    <GlassHeader>
      <Pressable hitSlop={8} onPress={onBack} style={styles.headerSlot}>
          <Ionicons name="chevron-back" size={26} color={colors.onyx} />
        </Pressable>
        {headerAvatars && headerAvatars.length > 0 ? (
          <View style={styles.headerAvatars}>
            {headerAvatars.slice(0, 3).map((avatar, index) => (
              <View
                key={avatar.actorId}
                style={[styles.headerAvatarTile, { marginLeft: index === 0 ? 0 : -8 }]}
              >
                {avatar.avatarUrl ? (
                  <Image
                    accessibilityRole="image"
                    source={{ uri: avatar.avatarUrl }}
                    style={styles.headerAvatarImage}
                  />
                ) : (
                  <Text style={styles.headerAvatarInitial}>{avatar.initial}</Text>
                )}
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.headerTitleBlock}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {title}
          </Text>
          <View style={styles.headerStatus}>
            <StatusDot kind={status.dot} size={6} />
            <Text style={styles.headerStatusLabel}>{status.label}</Text>
            <Text style={styles.headerSeparator}>·</Text>
            <Text style={styles.headerStatusLabel}>
              {session.participantCount}{" "}
              {session.participantCount === 1 ? tHook("actor") : tHook("actors")}
            </Text>
          </View>
        </View>
        {onTogglePlans ? (
          <Pressable
            accessibilityLabel={plansPanelOpen ? tHook("Hide plans") : tHook("Show plans")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onTogglePlans}
            style={styles.headerSlot}
          >
            <Ionicons
              color={plansPanelOpen ? colors.cinnabar : colors.onyx}
              name="list-outline"
              size={20}
            />
          </Pressable>
        ) : null}
        {onShare || onSearch ? (
          // Search and share share one "…" menu, as on iOS, so the header
          // keeps room for the title.
          <Pressable
            accessibilityLabel={tHook("Conversation options")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              const actions: SheetAction[] = [];
              if (onSearch) actions.push({ label: tHook("Search in conversation"), run: onSearch });
              if (onShare) actions.push({ label: tHook("Share"), run: onShare });
              showActionSheet(actions, { cancelLabel: tHook("Cancel") });
            }}
            style={styles.headerSlot}
            testID="session.optionsMenu"
          >
            <Ionicons color={colors.onyx} name="ellipsis-horizontal" size={20} />
          </Pressable>
        ) : null}
        <Pressable hitSlop={8} onPress={onOpenMembers} style={styles.headerSlot}>
          <Ionicons
            name="people-outline"
            size={22}
            color={onOpenMembers ? colors.onyx : colors.slate}
          />
        </Pressable>
        {onToggleMute ? (
          <Pressable
            accessibilityLabel={isMuted ? tHook("Unmute notifications") : tHook("Mute notifications")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onToggleMute}
            style={styles.headerSlot}
          >
            <Ionicons
              color={isMuted ? colors.cinnabar : colors.onyx}
              name={isMuted ? "notifications-off-outline" : "notifications-outline"}
              size={20}
            />
          </Pressable>
        ) : null}
        {onToggleAutoApprove ? (
          <Pressable
            accessibilityLabel={
              autoApprove ? tHook("Stop auto-approving permissions") : tHook("Auto-approve permissions")
            }
            accessibilityRole="switch"
            accessibilityState={{ checked: Boolean(autoApprove) }}
            hitSlop={8}
            onPress={onToggleAutoApprove}
            style={styles.headerSlot}
          >
            <Ionicons
              color={autoApprove ? colors.cinnabar : colors.onyx}
              name={autoApprove ? "shield-checkmark" : "shield-checkmark-outline"}
              size={20}
            />
          </Pressable>
      ) : null}
    </GlassHeader>
  );
}

function streamPreview(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function formatTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}


function runtimeEventBody(message: SessionMessage): string {
  const body = message.content.trim();
  if (message.kind.trim().toLowerCase() === "agent_thinking") {
    return buildThinkingPreview(body, 120);
  }
  if (body) return body;
  return t("Working…");
}

function agentTurnPreview(turn: AgentTurnFeedItem): string {
  const finalBody = turn.finalMessage?.content.trim();
  if (finalBody) return finalBody;
  const streamBody = streamPreview(turn.stream?.text ?? "");
  if (streamBody) return streamBody;
  const lastRuntime = turn.runtimeEvents[turn.runtimeEvents.length - 1];
  if (lastRuntime) return runtimeEventBody(lastRuntime);
  return t("Working…");
}

function agentTurnTime(turn: AgentTurnFeedItem): string {
  return formatTime(turn.finalMessage?.createdAt || turn.stream?.startedAt || turn.createdAt);
}

function agentTurnDetailCount(turn: AgentTurnFeedItem): number {
  return turn.runtimeEvents.length + (turn.stream?.text.trim() ? 1 : 0);
}

function isOwnOutgoingFeedSource(
  source: SessionFeedSource,
  ownActorId?: string | null,
): boolean {
  return Boolean(
    ownActorId &&
      source.kind === "message" &&
      source.message.senderActorId === ownActorId,
  );
}

const turnMarkdown = {
  body: { color: hai.onyx, ...typography.body, marginBottom: 0, marginTop: 0 },
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
  link: { color: hai.cinnabar, textDecorationLine: "underline" as const },
  paragraph: { color: hai.onyx, marginBottom: 0, marginTop: 0 },
};

function AgentTurnCard({
  onLongPress,
  onOpenDetail,
  onInterrupt,
  feedbackKind = null,
  onFeedback,
  senderAvatarGlyph,
  senderAvatarUrl,
  senderName,
  turn,
}: {
  /** Copy / reply / ask again / select, for a finished reply. */
  onLongPress?: () => void;
  onOpenDetail?: (turn: AgentTurnFeedItem) => void;
  onInterrupt?: (agentId: string) => void;
  /** The member's own 👍/👎 on this turn's final reply. */
  feedbackKind?: FeedbackKind | null;
  onFeedback?: (messageId: string, kind: FeedbackKind) => void;
  senderAvatarGlyph?: string | null;
  senderAvatarUrl?: string | null;
  senderName?: string;
  turn: AgentTurnFeedItem;
}) {
  const { t: tHook } = useTranslation();
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    if (!turn.isActive || turn.stream?.isComplete) {
      setCursorVisible(false);
      return;
    }
    const timer = setInterval(() => {
      setCursorVisible((value) => !value);
    }, 420);
    return () => clearInterval(timer);
  }, [turn.isActive, turn.stream?.isComplete]);
  const displayName = senderName ?? tHook("Agent");
  const avatarGlyph = senderAvatarGlyph ?? (displayName.charAt(0).toUpperCase() || "AI");
  const preview = agentTurnPreview(turn);
  const time = agentTurnTime(turn);
  const detailCount = agentTurnDetailCount(turn);
  const isWorking = turn.isActive && !turn.stream?.isComplete;
  return (
    <View style={[styles.row, styles.rowOther]}>
      <View style={styles.senderAvatar}>
        {senderAvatarUrl ? (
          <Image
            accessibilityRole="image"
            source={{ uri: senderAvatarUrl }}
            style={styles.senderAvatarImage}
          />
        ) : (
          <Text style={styles.senderAvatarText}>{avatarGlyph}</Text>
        )}
      </View>
      <Pressable
        accessibilityHint={tHook("Open agent turn details")}
        accessibilityRole="button"
        delayLongPress={350}
        onLongPress={onLongPress}
        onPress={onOpenDetail ? () => onOpenDetail(turn) : undefined}
        style={({ pressed }) => [
          styles.turnCard,
          turn.isActive ? styles.turnCardActive : null,
          pressed && onOpenDetail ? styles.turnCardPressed : null,
        ]}
      >
        <View style={styles.turnHeader}>
          <View style={styles.turnTitleRow}>
            <StatusDot kind={isWorking ? "working" : "active"} size={7} />
            <Text numberOfLines={1} style={styles.turnTitle}>
              {displayName}
            </Text>
            <Text style={styles.turnBadge}>
              {turn.isActive
                ? turn.stream?.isComplete
                  ? tHook("Syncing")
                  : tHook("Replying")
                : tHook("Reply")}
            </Text>
          </View>
          <View style={styles.turnActions}>
            {time ? <Text style={styles.turnTime}>{time}</Text> : null}
            <Ionicons color={colors.slate} name="chevron-forward" size={14} />
          </View>
          {isWorking && onInterrupt ? (
            <Pressable
              accessibilityLabel={tHook("Interrupt {{value}}", { value: displayName })}
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => onInterrupt(turn.agentId)}
              style={styles.turnStopButton}
            >
              <Ionicons color={colors.cinnabarDeep} name="stop" size={10} />
            </Pressable>
          ) : null}
        </View>
        {(turn.finalMessage?.model || turn.stream?.model) ? (
          <Text numberOfLines={1} style={styles.turnModel}>
            {turn.finalMessage?.model || turn.stream?.model}
          </Text>
        ) : null}
        {turn.finalMessage ? (
          <Markdown style={turnMarkdown}>{preview || tHook("(empty message)")}</Markdown>
        ) : (
          <Text numberOfLines={4} style={styles.turnPreview}>
            {preview}
            {isWorking && cursorVisible ? " ▌" : ""}
          </Text>
        )}
        {detailCount > 0 ? (
          <View style={styles.turnDetailRow}>
            <Ionicons color={colors.slate} name="list-outline" size={13} />
            <Text style={styles.turnDetailText}>
              {tHook("Process · {{count}}", { count: detailCount })}
            </Text>
          </View>
        ) : null}
        {/* Completed agent replies are drawn here, not as message rows, so
            the thumbs (iOS CompletedTurnBubbleView.onFeedback) live here too. */}
        {turn.finalMessage && !turn.isActive && onFeedback ? (
          <View style={styles.turnFeedbackRow}>
            {(["positive", "negative"] as const).map((kind) => {
              const active = feedbackKind === kind;
              const icon = kind === "positive" ? "thumbs-up" : "thumbs-down";
              const messageId = turn.finalMessage!.messageId;
              return (
                <Pressable
                  accessibilityLabel={kind === "positive" ? tHook("Helpful") : tHook("Not Helpful")}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  hitSlop={8}
                  key={kind}
                  onPress={() => onFeedback(messageId, kind)}
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
      </Pressable>
    </View>
  );
}

/**
 * Sheet wrapper around `TurnDetailScreen`.
 *
 * iOS pushes this as a navigation destination; expo-router modals are the
 * closest equivalent that keeps the session underneath alive, which matters —
 * the live MQTT subscription that feeds the trace belongs to that screen.
 */
function AgentTurnDetailModal({
  onClose,
  onDenyPermission,
  onGrantPermission,
  onInterrupt,
  planText,
  senderName,
  turn,
}: {
  onClose: () => void;
  onDenyPermission?: (requestId: string, message: SessionMessage) => void;
  onGrantPermission?: (requestId: string, message: SessionMessage) => void;
  onInterrupt?: (agentId: string) => void;
  planText?: string | null;
  senderName?: string;
  turn: AgentTurnFeedItem | null;
}) {
  return (
    <SheetModal
      onRequestClose={onClose}
      visible={turn !== null}
    >
      {turn ? (
        <TurnDetailScreen
          agentName={senderName ?? t("Agent")}
          onClose={onClose}
          onDenyPermission={onDenyPermission}
          onGrantPermission={onGrantPermission}
          onInterrupt={onInterrupt}
          planText={planText}
          turn={turn}
        />
      ) : null}
    </SheetModal>
  );
}

export function SessionDetailScreen(props: SessionDetailScreenProps) {
  const { t: tHook } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  // The root layout reserves only the top inset; this screen pins the
  // composer to the bottom, so it owns the home-indicator / nav-bar strip.
  const bottomInset = safeAreaInsets.bottom;
  const {
    agentChips,
    composerText,
    connectionState,
    headerAvatars,
    isMuted,
    isSending,
    mentionPool,
    onAgentInterrupt,
    onAgentRemove,
    feedbackByMessageId,
    onFeedback,
    onAttach,
    onBack,
    onChangeComposerText,
    onChangeRuntimeModel,
    focusMessageId,
    onAskAgain,
    onForwardText,
    onDeleteMessages,
    onClearReply,
    onDeleteMessage,
    onEditMessage,
    onGrantPermission,
    onDenyPermission,
    onLoadOlder,
    resolvedPermissionsByRequestId,
    onOpenMembers,
    onReconnect,
    onRefresh,
    onRequestTurnHistory,
    traceEventsByTurnId,
    onRetryFailed,
    onReplyToMessage,
    onSend,
    onShare,
    onToggleMute,
    autoApprove,
    onToggleAutoApprove,
    onAnswerQuestion,
    onSkipQuestion,
    pendingQuestion,
    isAnsweringQuestion,
    questionErrorMessage,
    ownActorId,
    replyTarget,
    runtimeInfo,
    isRefreshing,
    senderAvatars,
    senderAvatarGlyphs,
    senderNames,
    sendErrorMessage,
    slashCommands,
    streamingAgentIds,
    todoText,
    state,
  } = props;
  const { session } = state;

  type FeedItem =
    | { kind: "separator"; key: string; label: string }
    | { kind: "message"; key: string; message: SessionMessage }
    | { kind: "agentTurn"; key: string; turn: AgentTurnFeedItem };

  // Pair each `agent_tool_result` with the call it answers, so one row carries
  // both and a failed tool is visibly different from one that succeeded.
  const { resultByToolId, foldedMessageIds } = useMemo(
    () => foldToolResults(state.messages),
    [state.messages],
  );

  const feedSources = useMemo(
    () =>
      buildSessionFeedSources(
        state.messages.filter((message) => !foldedMessageIds.has(message.messageId)),
        state.streamingByAgent,
        { ownActorId },
      ),
    [foldedMessageIds, ownActorId, state.messages, state.streamingByAgent],
  );
  const [selectedTurnKey, setSelectedTurnKey] = useState<string | null>(null);
  const selectedTurn = useMemo(() => {
    const source = feedSources.find((item) => item.key === selectedTurnKey);
    if (source?.kind !== "agentTurn") return null;
    const trace = source.turn.daemonTurnId
      ? traceEventsByTurnId?.get(source.turn.daemonTurnId)
      : undefined;
    return trace && trace.length > 0 ? { ...source.turn, runtimeEvents: trace } : source.turn;
  }, [feedSources, selectedTurnKey, traceEventsByTurnId]);

  // Ask the daemon to replay this turn's thinking / tool-call events when the
  // detail opens. Live streams already receive deltas over MQTT and the
  // reducer dedupes overlap, so we don't gate on "do we already have events" —
  // a redundant request is cheaper than a detail view missing the trace.
  const selectedDaemonTurnId = selectedTurn?.daemonTurnId ?? null;
  const selectedTurnAgentId = selectedTurn?.agentId ?? null;
  useEffect(() => {
    if (!onRequestTurnHistory || !selectedDaemonTurnId || !selectedTurnAgentId) return;
    onRequestTurnHistory(selectedDaemonTurnId, selectedTurnAgentId);
  }, [onRequestTurnHistory, selectedDaemonTurnId, selectedTurnAgentId]);

  const feedItems: FeedItem[] = [];
  for (let i = 0; i < feedSources.length; i += 1) {
    const current = feedSources[i];
    const prev = i > 0 ? feedSources[i - 1] : null;
    if (!prev || !isSameCalendarDay(prev.createdAt, current.createdAt)) {
      feedItems.push({
        kind: "separator" as const,
        key: `sep:${current.key}`,
        label: dayLabel(current.createdAt),
      });
    }
    if (current.kind === "message") {
      feedItems.push({
        kind: "message",
        key: current.key,
        message: current.message,
      });
    } else {
      feedItems.push({
        kind: "agentTurn",
        key: current.key,
        turn: current.turn,
      });
    }
  }

  const hasMessages = feedSources.length > 0;

  const messageListRef = useRef<FlatList<FeedItem> | null>(null);
  const feedKeys = feedSources.map((source) => source.key);
  const previousFeedKeys = useRef<string[]>(feedKeys);
  const hasMeasuredFeedLayout = useRef(false);
  // The row to land on when the session opens, instead of the bottom: the
  // message a push pointed at, else where the reader left off last time
  // (iOS #1709). Cleared once reached, given up on, or the reader scrolls.
  const sessionKey = session.sessionId;
  const [openedReadPosition] = useState(() => getReadPosition(sessionKey));
  const pendingTarget = useRef<
    | { mode: "focus"; messageId: string; pagesPulled: number }
    | { mode: "anchor"; key: string }
    | null
  >(
    focusMessageId
      ? { mode: "focus", messageId: focusMessageId, pagesPulled: 0 }
      : openedReadPosition?.anchorKey
        ? { mode: "anchor", key: openedReadPosition.anchorKey }
        : null,
  );
  const openedOnTarget = useRef(pendingTarget.current !== null);
  const shouldStickToFeedBottom = useRef(!openedOnTarget.current);
  const targetSettleUntil = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [unreadPill, setUnreadPill] = useState<{ count: number; firstKey: string } | null>(null);
  const unreadPillKeyRef = useRef<string | null>(null);
  unreadPillKeyRef.current = unreadPill?.firstKey ?? null;
  const visibleKeysRef = useRef<string[]>([]);

  const outboxByMessageId = useSyncExternalStore(
    subscribeOutbox,
    getOutboxSnapshot,
    getOutboxSnapshot,
  );
  const pendingAttachments = useSyncExternalStore(
    subscribePendingAttachments,
    () => getPendingAttachmentSnapshot(state.session.teamId, state.session.sessionId),
    () => getPendingAttachmentSnapshot(state.session.teamId, state.session.sessionId),
  );

  const planSnapshots = useMemo<AgentPlanSnapshot[]>(
    () =>
      deriveAgentPlanSnapshots(state.messages, (agentId) => {
        return senderNames?.get(agentId) ?? "";
      }),
    [state.messages, senderNames],
  );
  const activeTodoText = todoText ?? planSnapshots[0]?.text ?? "";
  const [plansPanelOpen, setPlansPanelOpen] = useState(true);
  useEffect(() => {
    // Reopen the panel automatically whenever a *new* agent gains an
    // unfinished plan. Doesn't reopen when the same set of agents just
    // updates their items.
    if (planSnapshots.length === 0) return;
    setPlansPanelOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planSnapshots.length]);

  const separatorIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < feedItems.length; i += 1) {
      if (feedItems[i].kind === "separator") out.push(i);
    }
    return out;
    // feedItems is derived from feedSources each render; safe to depend on length only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedSources.length]);

  const hasFeedHeader =
    state.isLoadingOlder || (state.canLoadOlder && onLoadOlder !== undefined);
  // VirtualizedList reads stickyHeaderIndices as positions among the scroll
  // view's children, and a ListHeaderComponent takes the first of those — so a
  // header shifts every day separator by one.
  const stickyIndices = useMemo(
    () => (hasFeedHeader ? separatorIndices.map((index) => index + 1) : separatorIndices),
    [hasFeedHeader, separatorIndices],
  );

  useEffect(() => {
    // Only growth at the *tail* is a new message to follow. A back-scrolled
    // page also makes the feed longer, and following that would scroll away
    // from the history the user just pulled.
    const tailStart = feedTailStartIndex(previousFeedKeys.current, feedKeys);
    previousFeedKeys.current = feedKeys;
    if (tailStart < 0) return;

    const appended = feedSources.slice(tailStart);
    const hasOwnOutgoingMessage = appended.some((source) =>
      isOwnOutgoingFeedSource(source, ownActorId),
    );
    if (
      shouldAutoScrollForNewFeedItem({
        isOwnOutgoingMessage: hasOwnOutgoingMessage,
        wasNearBottom: shouldStickToFeedBottom.current,
      })
    ) {
      shouldStickToFeedBottom.current = true;
      // New message appended while the user is already following the tail.
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToEnd({ animated: true });
      });
    } else {
      // Reading history: count what arrived below for the jump button.
      setNewBelowCount((count) => count + appended.length);
    }
    // feedKeys is rebuilt every render; the ref comparison above is what makes
    // this idempotent, not the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedSources, ownActorId]);

  const handleFeedScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    // While landing on a target the list is still growing and jumping; a
    // momentary "near the bottom" here would hand control back to the
    // follow-the-tail logic and snap the feed to the end.
    if (pendingTarget.current || Date.now() < targetSettleUntil.current) return;
    const nearBottom = isFeedNearBottom({
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    });
    shouldStickToFeedBottom.current = nearBottom;
    setIsAtBottom(nearBottom);
    if (nearBottom) setNewBelowCount(0);
  };

  // Rows far off screen have estimated heights, so a jump can miss; measure
  // toward it and try again (a few times) until the row is actually laid out.
  const scrollRetry = useRef({ attempts: 0, viewPosition: 0 });
  const scrollToFeedIndex = (index: number, viewPosition: number, isRetry = false) => {
    if (index < 0) return;
    if (!isRetry) scrollRetry.current = { attempts: 0, viewPosition };
    try {
      messageListRef.current?.scrollToIndex({ animated: false, index, viewPosition });
    } catch {
      // onScrollToIndexFailed handles the retry
    }
  };
  const handleScrollToIndexFailed = (info: {
    index: number;
    averageItemLength: number;
  }) => {
    messageListRef.current?.scrollToOffset({
      animated: false,
      offset: info.averageItemLength * info.index,
    });
    if (scrollRetry.current.attempts >= 4) return;
    scrollRetry.current.attempts += 1;
    setTimeout(() => scrollToFeedIndex(info.index, scrollRetry.current.viewPosition, true), 80);
  };

  const readRows = useMemo<ReadPositionRow[]>(
    () =>
      feedSources.map((source) => ({
        key: source.key,
        createdAt: source.createdAt,
        isOwn: isOwnOutgoingFeedSource(source, ownActorId),
      })),
    [feedSources, ownActorId],
  );

  // Land on the pending target once its row is in the feed. A pushed message
  // older than the loaded page pulls older pages (bounded); anything still
  // missing once history settles falls back to the bottom.
  useEffect(() => {
    const target = pendingTarget.current;
    if (!target || !hasMessages) return;
    const key =
      target.mode === "focus"
        ? feedKeyContainingMessageId(feedSources, target.messageId)
        : feedSources.some((source) => source.key === target.key)
          ? target.key
          : null;
    if (key) {
      pendingTarget.current = null;
      targetSettleUntil.current = Date.now() + 1500;
      // Scroll events are ignored while settling, so say "not at the bottom"
      // here; the reader's next scroll corrects it if the target was the end.
      setIsAtBottom(false);
      const index = feedItems.findIndex((item) => item.key === key);
      requestAnimationFrame(() =>
        scrollToFeedIndex(index, target.mode === "focus" ? 0.5 : 0),
      );
      if (target.mode === "focus") {
        setHighlightKey(key);
        setTimeout(() => setHighlightKey((current) => (current === key ? null : current)), 2000);
      }
      return;
    }
    if (!state.historySettled || state.isLoadingOlder) return;
    if (target.mode === "focus" && state.canLoadOlder && onLoadOlder && target.pagesPulled < 10) {
      target.pagesPulled += 1;
      onLoadOlder();
      return;
    }
    pendingTarget.current = null;
    shouldStickToFeedBottom.current = true;
    requestAnimationFrame(() => messageListRef.current?.scrollToEnd({ animated: false }));
    // feedItems is rebuilt from feedSources every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedSources, hasMessages, state.historySettled, state.isLoadingOlder, state.canLoadOlder]);

  // "N unread ↑": once the network page is in, count what others posted since
  // the reader was last here. Shown from FIRST_UNREAD_THRESHOLD rows, until
  // the first unread row is seen or the pill is tapped.
  const unreadComputed = useRef(false);
  useEffect(() => {
    if (unreadComputed.current || !state.historySettled) return;
    unreadComputed.current = true;
    measureChatMetric("chat.open_session", sessionKey, "rows", readRows.length);
    // An empty session never lays out a feed; its empty state is the frame.
    if (readRows.length === 0) markChatMetric("chat.open_session", sessionKey, "first_frame");
    markChatMetric("chat.open_session", sessionKey, "seeded");
    const { count, firstKey } = unreadSince(readRows, openedReadPosition?.readAt ?? null);
    if (firstKey && count >= FIRST_UNREAD_THRESHOLD && !visibleKeysRef.current.includes(firstKey)) {
      setUnreadPill({ count, firstKey });
    }
  }, [openedReadPosition, readRows, state.historySettled]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ReadonlyArray<{ key: string }> }) => {
      visibleKeysRef.current = viewableItems.map((item) => item.key);
      const pillKey = unreadPillKeyRef.current;
      if (pillKey && visibleKeysRef.current.includes(pillKey)) setUnreadPill(null);
    },
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  // Remember where the reader is on the way out (and when backgrounded, in
  // case the app is killed there).
  const readRowsRef = useRef(readRows);
  readRowsRef.current = readRows;
  useEffect(() => {
    const persist = () => {
      if (readRowsRef.current.length === 0) return;
      const next = positionOnLeave({
        previous: getReadPosition(sessionKey),
        rows: readRowsRef.current,
        visibleKeys: visibleKeysRef.current,
        isAtBottom: shouldStickToFeedBottom.current,
      });
      if (next) void saveReadPosition(sessionKey, next);
    };
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") persist();
    });
    return () => {
      subscription.remove();
      persist();
    };
  }, [sessionKey]);

  const jumpToBottom = () => {
    selectionTick();
    shouldStickToFeedBottom.current = true;
    setNewBelowCount(0);
    messageListRef.current?.scrollToEnd({ animated: true });
  };
  const jumpToFirstUnread = () => {
    if (!unreadPill) return;
    selectionTick();
    const index = feedItems.findIndex((item) => item.key === unreadPill.firstKey);
    setUnreadPill(null);
    scrollToFeedIndex(index, 0);
  };

  const sourceByKey = useMemo(
    () => new Map(feedSources.map((source) => [source.key, source] as const)),
    [feedSources],
  );
  const scrollToKey = (key: string, viewPosition: number) => {
    shouldStickToFeedBottom.current = false;
    scrollToFeedIndex(feedItems.findIndex((item) => item.key === key), viewPosition);
  };

  // Find in conversation (iOS #1709): matches over what is loaded here, the
  // current one centred and highlighted, starting from the newest.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(-1);
  const searchMatches = useMemo(
    () => (searchOpen ? feedSearchMatches(feedSources, searchQuery) : []),
    [feedSources, searchOpen, searchQuery],
  );
  const searchMatchCount = searchMatches.length;
  useEffect(() => {
    setSearchIndex(searchMatchCount - 1);
    // A new query starts again from the newest match; new rows arriving
    // while browsing matches must not move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, searchQuery]);
  const currentMatchKey = searchMatches[searchIndex] ?? null;
  useEffect(() => {
    if (!searchOpen) return;
    setHighlightKey(currentMatchKey);
    if (currentMatchKey) scrollToKey(currentMatchKey, 0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatchKey, searchOpen]);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setHighlightKey(null);
  };

  // Multi-select: copy, forward or delete several messages at once.
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const startSelection = (key: string) => {
    selectionTick();
    closeSearch();
    setSelection(new Set([key]));
  };
  const toggleSelected = (key: string) => {
    selectionTick();
    setSelection((previous) => {
      const next = new Set(previous ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const pickedMessages = useMemo(
    () => (selection ? selectedMessages(feedSources, selection) : []),
    [feedSources, selection],
  );
  const senderLabel = (actorId: string) => senderNames?.get(actorId) ?? tHook("Unknown");
  const transcriptOf = (header?: string) =>
    composeTranscript(
      pickedMessages.map((m) => ({ sender: senderLabel(m.senderActorId), text: displayText(m) })),
      header,
    );
  const selectionCanDelete =
    Boolean(onDeleteMessages) &&
    canDeleteSelection(pickedMessages, ownActorId, (id) => {
      const status = outboxByMessageId.get(id);
      return status === undefined || status === "sent";
    });

  const showTurnActions = (key: string, turn: AgentTurnFeedItem) => {
    const final = turn.finalMessage;
    if (!final || turn.isActive) return;
    const actions: SheetAction[] = [
      {
        label: tHook("Copy"),
        run: () => {
          void Clipboard.setStringAsync(displayText(final));
          successTone();
        },
      },
    ];
    if (onReplyToMessage) {
      actions.push({ label: tHook("Reply"), run: () => onReplyToMessage(final.messageId) });
    }
    const prompt = promptForTurn(feedSources, key);
    if (prompt && onAskAgain) {
      // Not a true regenerate: the agent sees its earlier answer in context.
      actions.push({
        label: tHook("Ask again"),
        run: () => {
          impactLight();
          onAskAgain({
            content: prompt.content,
            replyToMessageId: prompt.replyToMessageId || null,
            agentId: turn.agentId,
          });
        },
      });
    }
    actions.push({ label: tHook("Select"), run: () => startSelection(key) });
    showActionSheet(actions, { cancelLabel: tHook("Cancel") });
  };

  const wrapRow = (key: string, node: React.ReactNode) => {
    const highlighted = key === highlightKey ? styles.highlightRow : null;
    const source = sourceByKey.get(key);
    if (!selection || !source || !selectableMessage(source)) {
      return <View style={highlighted}>{node}</View>;
    }
    const checked = selection.has(key);
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => toggleSelected(key)}
        style={[styles.selectRow, highlighted]}
      >
        <View style={[styles.selectCircle, checked ? styles.selectCircleOn : null]}>
          {checked ? <Ionicons color={colors.background} name="checkmark" size={13} /> : null}
        </View>
        <View pointerEvents="none" style={styles.selectRowBody}>
          {node}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.screen}>
      <SessionHeader
        connectionState={connectionState}
        headerAvatars={headerAvatars}
        isMuted={isMuted}
        onBack={onBack}
        onOpenMembers={onOpenMembers}
        onShare={onShare}
        onSearch={() => {
          setSelection(null);
          setSearchOpen(true);
        }}
        onTogglePlans={
          planSnapshots.length > 0
            ? () => setPlansPanelOpen((value) => !value)
            : undefined
        }
        plansPanelOpen={plansPanelOpen && planSnapshots.length > 0}
        onToggleMute={onToggleMute}
        autoApprove={autoApprove}
        onToggleAutoApprove={onToggleAutoApprove}
        session={session}
      />
      <ConnectionBannerOverlay
        connectionState={connectionState}
        onReconnect={onReconnect}
      />
      {plansPanelOpen && planSnapshots.length > 0 ? (
        <SessionPlansPanel
          onClose={() => setPlansPanelOpen(false)}
          snapshots={planSnapshots}
        />
      ) : null}
      {runtimeInfo ? (
        <Pressable
          accessibilityRole={onChangeRuntimeModel ? "button" : undefined}
          disabled={!onChangeRuntimeModel}
          onPress={onChangeRuntimeModel}
          style={({ pressed }) => [
            styles.runtimeBar,
            pressed && onChangeRuntimeModel ? styles.runtimeBarPressed : null,
          ]}
        >
          <StatusDot kind={runtimeStatusKind(runtimeInfo.status)} size={6} />
          <Text style={styles.runtimeLabel}>
            {tHook("Runtime")} · {runtimeInfo.status}
            {runtimeInfo.currentModel ? ` · ${runtimeInfo.currentModel}` : ""}
          </Text>
          {onChangeRuntimeModel ? (
            <Ionicons color={colors.slate} name="chevron-down" size={12} />
          ) : null}
        </Pressable>
      ) : null}

      {state.status === "error" ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{state.errorMessage}</Text>
        </View>
      ) : null}

      <View style={styles.feed}>
        {hasMessages ? (
          <FlatList
            contentContainerStyle={styles.feedContent}
            data={feedItems}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => item.key}
            ListHeaderComponent={
              // Also the retry path: `onStartReached` fires once per content
              // length, so a page that fails to load leaves the gesture spent
              // until the feed changes underneath it.
              // Keep this in step with `hasFeedHeader`, which offsets the
              // sticky separators.
              state.isLoadingOlder ? (
                <View style={styles.loadOlder}>
                  <ActivityIndicator color={colors.slate} size="small" />
                </View>
              ) : state.canLoadOlder && onLoadOlder ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onLoadOlder}
                  style={({ pressed }) => [
                    styles.loadOlder,
                    pressed ? styles.loadOlderPressed : null,
                  ]}
                >
                  <Text style={styles.loadOlderText}>{tHook("Load older messages")}</Text>
                </Pressable>
              ) : null
            }
            // Anchors the scroll to the first row that was already on screen,
            // so a page arriving above it does not shove the transcript down.
            maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
            onStartReached={() => {
              if (
                !onLoadOlder ||
                !shouldLoadOlderOnStartReached({
                  canLoadOlder: state.canLoadOlder,
                  isLoadingOlder: state.isLoadingOlder,
                  wasNearBottom: shouldStickToFeedBottom.current,
                })
              ) {
                return;
              }
              onLoadOlder();
            }}
            onStartReachedThreshold={0.3}
            onContentSizeChange={() => {
              // Opening on a target already positioned the feed; the first
              // layout must not snap it back to the end.
              if (!hasMeasuredFeedLayout.current) {
                markChatMetric("chat.open_session", sessionKey, "first_frame");
              }
              const isInitialLayout = !hasMeasuredFeedLayout.current && !openedOnTarget.current;
              hasMeasuredFeedLayout.current = true;
              // Opening on a pushed message or a saved position, not the end.
              if (pendingTarget.current) return;
              if (
                shouldAutoScrollFeed({
                  isInitialLayout,
                  wasNearBottom: shouldStickToFeedBottom.current,
                })
              ) {
                messageListRef.current?.scrollToEnd({ animated: false });
              }
            }}
            onScroll={handleFeedScroll}
            onScrollBeginDrag={() => {
              // The reader took over; stop steering toward the saved spot.
              if (pendingTarget.current?.mode === "anchor") pendingTarget.current = null;
              targetSettleUntil.current = 0;
            }}
            onScrollToIndexFailed={handleScrollToIndexFailed}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  onRefresh={onRefresh}
                  refreshing={Boolean(isRefreshing)}
                  tintColor={colors.slate}
                />
              ) : undefined
            }
            ref={messageListRef}
            extraData={`${highlightKey ?? ""}|${selection ? [...selection].join(",") : "-"}`}
            scrollEventThrottle={80}
            stickyHeaderIndices={stickyIndices}
            renderItem={({ item }) => {
              if (item.kind === "separator") {
                return <DaySeparator label={item.label} />;
              }
              if (item.kind === "agentTurn") {
                return wrapRow(
                  item.key,
                  <AgentTurnCard
                    onLongPress={selection ? undefined : () => showTurnActions(item.key, item.turn)}
                    onOpenDetail={() => setSelectedTurnKey(item.key)}
                    onInterrupt={onAgentInterrupt}
                    feedbackKind={
                      item.turn.finalMessage
                        ? feedbackByMessageId?.get(item.turn.finalMessage.messageId) ?? null
                        : null
                    }
                    onFeedback={onFeedback}
                    senderAvatarGlyph={
                      senderAvatarGlyphs?.get(item.turn.agentId) ?? null
                    }
                    senderAvatarUrl={senderAvatars?.get(item.turn.agentId) ?? null}
                    senderName={senderNames?.get(item.turn.agentId) ?? undefined}
                    turn={item.turn}
                  />,
                );
              }
              const msg = item.message;
              const isOwn = ownActorId ? msg.senderActorId === ownActorId : false;
              const replyToMessage =
                msg.replyToMessageId && msg.replyToMessageId.length > 0
                  ? state.messages.find((m) => m.messageId === msg.replyToMessageId) ??
                    null
                  : null;
              const rowSource = sourceByKey.get(item.key);
              return wrapRow(
                item.key,
                <SessionMessageRow
                  isOwnMessage={isOwn}
                  onSelect={
                    !selection && rowSource && selectableMessage(rowSource)
                      ? () => startSelection(item.key)
                      : undefined
                  }
                  message={msg}
                  onDelete={onDeleteMessage}
                  onEdit={
                    onEditMessage
                      ? (m) => onEditMessage(m.messageId, m.content)
                      : undefined
                  }
                  onJumpToReply={(targetId) => {
                    const index = feedItems.findIndex(
                      (entry) => entry.kind === "message" && entry.message.messageId === targetId,
                    );
                    if (index >= 0) {
                      messageListRef.current?.scrollToIndex({
                        animated: true,
                        index,
                        viewPosition: 0.3,
                      });
                    }
                  }}
                  onRetryOutbox={onRetryFailed}
                  feedbackKind={feedbackByMessageId?.get(msg.messageId) ?? null}
                  onFeedback={onFeedback ? (kind) => onFeedback(msg.messageId, kind) : undefined}
                  toolResult={(() => {
                    if (msg.kind.trim().toLowerCase() !== "agent_tool_call") return undefined;
                    const meta =
                      msg.metadata && typeof msg.metadata === "object"
                        ? (msg.metadata as Record<string, unknown>)
                        : {};
                    const toolId =
                      typeof meta.tool_id === "string" ? meta.tool_id : "";
                    return toolId ? resultByToolId.get(toolId) : undefined;
                  })()}
                  onReply={
                    onReplyToMessage
                      ? (m) => onReplyToMessage(m.messageId)
                      : undefined
                  }
                  outboxStatus={
                    isOwn
                      ? (outboxByMessageId.get(msg.messageId) as OutboxStatus | undefined)
                      : undefined
                  }
                  onGrantPermission={onGrantPermission}
                  onDenyPermission={onDenyPermission}
                  resolvedPermission={(() => {
                    if (msg.kind.trim().toLowerCase() !== "permission_request")
                      return null;
                    const meta =
                      msg.metadata && typeof msg.metadata === "object"
                        ? (msg.metadata as Record<string, unknown>)
                        : {};
                    const requestId =
                      (typeof meta.tool_id === "string" && (meta.tool_id as string)) ||
                      (typeof meta.request_id === "string" &&
                        (meta.request_id as string)) ||
                      msg.messageId;
                    const decision = resolvedPermissionsByRequestId?.get(requestId);
                    return decision === undefined ? null : { granted: decision };
                  })()}
                  replyToMessage={replyToMessage}
                  senderName={
                    !isOwn ? senderNames?.get(msg.senderActorId) ?? undefined : undefined
                  }
                />,
              );
            }}
          />
        ) : (
          <View style={styles.empty}>
            <Ionicons
              color={colors.slate}
              name="chatbubbles-outline"
              size={40}
            />
            <Text style={styles.emptyTitle}>{tHook("No messages yet")}</Text>
            <Text style={styles.emptyBody}>
              {tHook("Be the first to write in this session.")}
            </Text>
          </View>
        )}
        {searchOpen ? (
          <View style={styles.searchOverlay}>
            <SessionSearchBar
              currentIndex={searchIndex}
              matchCount={searchMatchCount}
              onChangeQuery={setSearchQuery}
              onDone={closeSearch}
              onNewer={() => {
                selectionTick();
                setSearchIndex((index) => Math.min(index + 1, searchMatchCount - 1));
              }}
              onOlder={() => {
                selectionTick();
                setSearchIndex((index) => Math.max(index - 1, 0));
              }}
              query={searchQuery}
            />
          </View>
        ) : null}
        {hasMessages && unreadPill && !searchOpen ? (
          <Pressable
            accessibilityLabel={tHook("{{value}} unread", { value: unreadPill.count })}
            accessibilityRole="button"
            onPress={jumpToFirstUnread}
            style={({ pressed }) => [styles.unreadPill, pressed ? styles.floatingPressed : null]}
            testID="session.firstUnread"
          >
            <Text style={styles.unreadPillText}>
              {tHook("{{value}} unread", { value: formatNewMessageCount(unreadPill.count) })}
            </Text>
            <Ionicons color={hai.cinnabar} name="arrow-up" size={12} />
          </Pressable>
        ) : null}
        {hasMessages && !isAtBottom ? (
          <Pressable
            accessibilityLabel={
              newBelowCount > 0
                ? tHook("{{value}} new messages", { value: newBelowCount })
                : tHook("Jump to latest")
            }
            accessibilityRole="button"
            onPress={jumpToBottom}
            style={({ pressed }) => [styles.jumpToBottom, pressed ? styles.floatingPressed : null]}
            testID="session.jumpToBottom"
          >
            <Ionicons color={hai.onyx} name="chevron-down" size={18} />
            {newBelowCount > 0 ? (
              <View style={styles.jumpBadge}>
                <Text style={styles.jumpBadgeText}>{formatNewMessageCount(newBelowCount)}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>

      {replyTarget && !selection ? (
        <View style={styles.replyBar}>
          <View style={styles.replyBarAccent} />
          <View style={styles.replyBarBody}>
            <Text style={styles.replyBarLabel}>{tHook("Replying to message")}</Text>
            <Text numberOfLines={1} style={styles.replyBarPreview}>
              {replyTarget.content || tHook("(empty message)")}
            </Text>
          </View>
          {onClearReply ? (
            <Pressable hitSlop={6} onPress={onClearReply} style={styles.replyBarClose}>
              <Ionicons color={colors.slate} name="close" size={16} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <AgentTurnDetailModal
        onClose={() => setSelectedTurnKey(null)}
        onDenyPermission={onDenyPermission}
        onGrantPermission={onGrantPermission}
        onInterrupt={onAgentInterrupt}
        planText={
          selectedTurn
            ? planSnapshots.find((snapshot) => snapshot.agentId === selectedTurn.agentId)
                ?.text ?? null
            : null
        }
        senderName={
          selectedTurn ? senderNames?.get(selectedTurn.agentId) ?? undefined : undefined
        }
        turn={selectedTurn}
      />

      {activeTodoText ? <TodoDock text={activeTodoText} /> : null}

      {(() => {
        const prefix = slashPrefix(composerText);
        if (prefix === null) return null;
        const candidates = filterSlashCommands(slashCommands ?? BUILT_IN_SLASH_COMMANDS, prefix);
        return (
          <SlashCommandsPopup
            candidates={candidates}
            onSelect={(command) => {
              onChangeComposerText(`/${command.name} `);
            }}
          />
        );
      })()}

      {(() => {
        if (!mentionPool || mentionPool.length === 0) return null;
        const query = mentionQuery(composerText);
        if (query === null) return null;
        const candidates = filterMentionCandidates(mentionPool, query);
        return (
          <MentionsPopup
            candidates={candidates}
            onSelect={(target) => onChangeComposerText(applyMention(composerText, target))}
          />
        );
      })()}

      {agentChips && agentChips.length > 0 ? (
        <AgentChipBar
          chips={agentChips}
          onInterrupt={onAgentInterrupt}
          onRemove={onAgentRemove}
          streamingAgentIds={streamingAgentIds}
        />
      ) : null}

      <KeyboardAvoidingView
        // Android too: under the edge-to-edge window SDK 57 enforces,
        // `adjustResize` no longer shrinks the window, so leaving Android to
        // the OS put the keyboard straight over the composer.
        behavior="padding"
        // The composer carries the bottom safe-area inset below (home
        // indicator / navigation bar). On iOS the keyboard's height already
        // covers that strip, so take it back out or the composer floats a
        // home-indicator's height above the keys. Edge-to-edge Android reports
        // the keyboard without the navigation bar, which the inset padding
        // makes up for exactly.
        // iOS: the view's frame is measured from below the root layout's
        // top safe-area padding, while the keyboard reports screen
        // coordinates — add that strip back or the composer's action row sits
        // behind the keys. It has to be the window's inset: the root
        // `SafeAreaView` consumes the top edge, so this screen's own context
        // reports 0 there.
        keyboardVerticalOffset={Platform.select({
          ios: (initialWindowMetrics?.insets.top ?? 0) + 8 - bottomInset,
          default: 0,
        })}
      >
        <View style={{ paddingBottom: bottomInset }}>
          {/* An unanswered question blocks the turn, so it takes the composer's
              place until it is answered or skipped — same swap iOS does. */}
          {selection ? (
            <MessageSelectionBar
              canDelete={selectionCanDelete}
              count={pickedMessages.length}
              onCancel={() => setSelection(null)}
              onCopy={() => {
                void Clipboard.setStringAsync(transcriptOf());
                successTone();
                showToast("success", tHook("Copied"));
                setSelection(null);
              }}
              onDelete={() => {
                onDeleteMessages?.(pickedMessages.map((m) => m.messageId));
                setSelection(null);
              }}
              onForward={() => {
                if (!onForwardText) return;
                const title = session.title.trim() || tHook("Untitled session");
                onForwardText(transcriptOf(tHook("Forwarded from “{{value}}”", { value: title })));
                setSelection(null);
              }}
            />
          ) : pendingQuestion && onAnswerQuestion && onSkipQuestion ? (
            <AcpQuestionCard
              errorMessage={questionErrorMessage}
              isSubmitting={isAnsweringQuestion}
              key={pendingQuestion.id}
              onSkip={() => onSkipQuestion(pendingQuestion)}
              onSubmit={(answers) => onAnswerQuestion(pendingQuestion, answers)}
              pending={pendingQuestion}
            />
          ) : (
            <SessionComposerShell
              composerText={composerText}
              connectionState={connectionState}
              isSending={isSending}
              onAttach={onAttach}
              onOpenAgents={onOpenMembers}
              selectedAgentNames={(agentChips ?? []).map((chip) => chip.displayName)}
              onChangeText={onChangeComposerText}
              onRemovePendingAttachment={(path) => {
                removePendingAttachment(state.session.teamId, state.session.sessionId, path);
              }}
              onSend={onSend}
              pendingAttachments={pendingAttachments}
              sendErrorMessage={sendErrorMessage}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
  },
  emptyBody: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  errorBanner: {
    backgroundColor: "rgba(184,75,54,0.10)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorBannerText: {
    color: colors.cinnabarDeep,
    ...typography.caption,
  },
  feed: {
    flex: 1,
  },
  floatingPressed: {
    opacity: 0.7,
  },
  searchOverlay: {
    left: 0,
    position: "absolute",
    right: 0,
    top: GLASS_HEADER_HEIGHT,
  },
  selectCircle: {
    alignItems: "center",
    borderColor: colors.slate,
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    marginLeft: spacing.md,
    width: 22,
  },
  selectCircleOn: {
    backgroundColor: hai.cinnabar,
    borderColor: hai.cinnabar,
  },
  selectRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  selectRowBody: {
    flex: 1,
  },
  highlightRow: {
    backgroundColor: colors.paper,
  },
  jumpBadge: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 4,
    position: "absolute",
    right: -4,
    top: -6,
  },
  jumpBadgeText: {
    color: colors.background,
    fontSize: 10,
    fontWeight: "600",
  },
  jumpToBottom: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: spacing.md,
    height: 36,
    justifyContent: "center",
    position: "absolute",
    right: spacing.lg,
    shadowColor: "#000",
    shadowOffset: { height: 1, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    width: 36,
    elevation: 3,
  },
  unreadPill: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    position: "absolute",
    right: spacing.lg,
    top: GLASS_HEADER_HEIGHT + spacing.sm,
    elevation: 2,
  },
  unreadPillText: {
    color: hai.cinnabar,
    fontSize: 12,
    fontWeight: "500",
  },
  feedContent: {
    paddingBottom: spacing.sm,
    // The header is pinned above the feed, so the first message needs room.
    paddingTop: GLASS_HEADER_HEIGHT + spacing.sm,
  },
  loadOlder: {
    alignItems: "center",
    paddingBottom: spacing.sm,
    paddingTop: spacing.xs,
  },
  loadOlderPressed: {
    opacity: 0.6,
  },
  loadOlderText: {
    color: colors.slate,
    ...typography.caption,
  },
  row: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    width: "100%",
  },
  rowOther: {
    alignItems: "flex-start",
  },
  senderAvatar: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: hai.basalt,
    borderRadius: 999,
    height: 24,
    justifyContent: "center",
    marginBottom: 4,
    overflow: "hidden",
    width: 24,
  },
  senderAvatarImage: {
    height: "100%",
    width: "100%",
  },
  senderAvatarText: {
    color: hai.paper,
    fontSize: 10,
    fontWeight: "700",
  },
  turnActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 3,
  },
  turnBadge: {
    color: colors.cinnabarDeep,
    ...typography.caption,
    fontSize: 10,
    fontWeight: "700",
  },
  turnPreview: {
    color: colors.onyx,
    ...typography.secondaryBody,
  },
  turnCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 5,
    maxWidth: "86%",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  turnCardActive: {
    borderColor: "rgba(184,75,54,0.24)",
  },
  turnCardPressed: {
    opacity: 0.88,
  },
  turnFeedbackRow: {
    flexDirection: "row",
    gap: 14,
    marginTop: 6,
  },
  turnDetailRow: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(226,223,217,0.55)",
    borderRadius: 8,
    flexDirection: "row",
    gap: 5,
    marginTop: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  turnDetailText: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  turnHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  turnModel: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  turnStopButton: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.14)",
    borderRadius: 999,
    height: 18,
    justifyContent: "center",
    width: 18,
  },
  turnTime: {
    color: colors.slate,
    ...typography.monoMeta,
    fontSize: 10,
  },
  turnTitle: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.caption,
    fontWeight: "700",
  },
  turnTitleRow: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 6,
  },
  headerSeparator: {
    color: colors.slate,
    paddingHorizontal: 2,
    ...typography.caption,
  },
  headerAvatarImage: {
    height: "100%",
    width: "100%",
  },
  headerAvatarInitial: {
    color: hai.paper,
    fontSize: 10,
    fontWeight: "700",
  },
  headerAvatarTile: {
    alignItems: "center",
    backgroundColor: hai.basalt,
    borderColor: colors.mist,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    overflow: "hidden",
    width: 22,
  },
  headerAvatars: {
    alignItems: "center",
    flexDirection: "row",
    marginLeft: 4,
    marginRight: 8,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  replyBar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  runtimeBar: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
  },
  runtimeBarPressed: {
    opacity: 0.7,
  },
  runtimeLabel: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  replyBarAccent: {
    backgroundColor: hai.cinnabar,
    borderRadius: 2,
    height: 28,
    width: 3,
  },
  replyBarBody: {
    flex: 1,
    gap: 1,
  },
  replyBarClose: {
    padding: 4,
  },
  replyBarLabel: {
    color: hai.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  replyBarPreview: {
    color: colors.basalt,
    ...typography.caption,
  },
  headerStatus: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    marginTop: 1,
  },
  headerStatusLabel: {
    color: colors.slate,
    ...typography.caption,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  headerTitleBlock: {
    alignItems: "center",
    flex: 1,
    paddingHorizontal: spacing.xs,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
});
