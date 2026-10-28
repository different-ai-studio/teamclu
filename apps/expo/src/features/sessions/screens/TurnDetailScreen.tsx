import { Ionicons } from "@expo/vector-icons";
import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { propsEqualIgnoringFunctions } from "../../../lib/memo-props";
import { Hairline } from "../../../ui/atoms/Hairline";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, iosType, spacing } from "../../../ui/theme";
import { SessionMessageRow } from "../components/SessionMessageRow";
import { TodoDock } from "../components/TodoDock";
import type { AgentTurnFeedItem } from "../session-feed-items";
import type { SessionMessage } from "../session-types";
import { foldToolResults } from "../tool-display";
import { sortTurnEvents, turnModelName } from "../turn-detail-events";

/** Same as the chat screen's: within this many points counts as "at the bottom". */
const NEAR_BOTTOM_THRESHOLD = 80;

export type TurnDetailScreenProps = {
  turn: AgentTurnFeedItem;
  agentName: string;
  /** Latest todo text for this agent; renders the bottom dock when present. */
  planText?: string | null;
  onClose: () => void;
  onInterrupt?: (agentId: string) => void;
  onGrantPermission?: (requestId: string, message: SessionMessage) => void;
  onDenyPermission?: (requestId: string, message: SessionMessage) => void;
};

/**
 * The full event trace behind one agent turn — thinking, tool calls, permission
 * requests and the reply that came out of them. Ports iOS
 * `StreamingDetailView`.
 *
 * This replaces a modal that showed *counts*: "Thinking · 4", "Tools · 7", each
 * a summary line built by `buildAgentTurnDetailGroups`. You could see that the
 * agent had run seven tools but not which, in what order, or whether any of
 * them failed. iOS renders the events themselves, with the same row components
 * the chat feed uses, so a tool call looks the same in both places.
 *
 * Still pinned to one turn: which turn is decided by the caller's selection, so
 * opening an old turn shows that turn and not whatever the agent is doing now.
 * Only a turn that is genuinely still active follows the live stream.
 */
export function TurnDetailScreen({
  turn,
  agentName,
  planText,
  onClose,
  onInterrupt,
  onGrantPermission,
  onDenyPermission,
}: TurnDetailScreenProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView | null>(null);
  // Rows skip renders (see `EventRow`), so their callbacks read these at call time.
  const permissionHandlers = useRef({ onGrantPermission, onDenyPermission });
  permissionHandlers.current = { onGrantPermission, onDenyPermission };

  const events = useMemo(() => {
    const all = turn.finalMessage
      ? [...turn.runtimeEvents, turn.finalMessage]
      : [...turn.runtimeEvents];
    return sortTurnEvents(all);
  }, [turn.finalMessage, turn.runtimeEvents]);

  const { resultByToolId, foldedMessageIds } = useMemo(
    () => foldToolResults(events),
    [events],
  );
  const visibleEvents = useMemo(
    () => events.filter((event) => !foldedMessageIds.has(event.messageId)),
    [events, foldedMessageIds],
  );

  const liveText = turn.stream && !turn.stream.isComplete ? turn.stream.text : "";
  const isStreaming = Boolean(turn.isActive && turn.stream && !turn.stream.isComplete);
  const modelName = turnModelName(events) ?? turn.stream?.model ?? null;

  // Anchor to the newest event, but only while the reader is at the bottom:
  // every token used to scroll back down, so earlier steps could not be read
  // while the agent was still running (iOS `StreamingDetailView`). Refs, not
  // state — scroll position changes far too often to re-render on.
  const isAtBottom = useRef(true);
  const isDragging = useRef(false);
  const followTail = () => {
    if (!isAtBottom.current || isDragging.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
  };
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    isAtBottom.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  };
  useEffect(followTail, [visibleEvents.length]);
  useEffect(() => {
    if (!isStreaming) return;
    followTail();
  }, [isStreaming, liveText]);

  const isEmpty = visibleEvents.length === 0 && liveText.length === 0;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("Back")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={styles.headerButton}
        >
          <Ionicons color={colors.onyx} name="chevron-back" size={24} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text numberOfLines={1} style={styles.title}>
            {agentName}
          </Text>
          {modelName ? (
            <Text numberOfLines={1} style={styles.subtitle}>
              {modelName}
            </Text>
          ) : null}
        </View>
        {isStreaming && onInterrupt ? (
          <Pressable
            accessibilityLabel={t("Interrupt agent")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onInterrupt(turn.agentId)}
            style={styles.headerButton}
          >
            <Ionicons color={hai.cinnabarDeep} name="stop" size={20} />
          </Pressable>
        ) : (
          <View style={styles.headerButton} />
        )}
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        onMomentumScrollEnd={() => {
          isDragging.current = false;
        }}
        onScroll={handleScroll}
        onScrollBeginDrag={() => {
          isDragging.current = true;
        }}
        onScrollEndDrag={(event) => {
          // No momentum to wait for when the finger lifts without a fling.
          if (!event.nativeEvent.velocity?.y) isDragging.current = false;
        }}
        ref={scrollRef}
        scrollEventThrottle={64}
      >
        {isEmpty ? (
          <View style={styles.emptyBlock}>
            <Ionicons color={colors.slate} name="sparkles-outline" size={36} />
            <Text style={styles.emptyText}>{t("Waiting for the agent…")}</Text>
          </View>
        ) : null}

        {visibleEvents.map((event) => (
          <EventRow
            key={event.messageId}
            message={event}
            onDenyPermission={
              onDenyPermission
                ? (requestId, m) => permissionHandlers.current.onDenyPermission?.(requestId, m)
                : undefined
            }
            onGrantPermission={
              onGrantPermission
                ? (requestId, m) => permissionHandlers.current.onGrantPermission?.(requestId, m)
                : undefined
            }
            senderName={agentName}
            toolResult={resultForCall(event, resultByToolId)}
          />
        ))}

        {isStreaming && liveText ? (
          <SessionMessageRow
            isStreaming
            message={streamingMessage(turn, liveText)}
            senderName={agentName}
          />
        ) : null}

        {turn.isActive ? (
          <View style={styles.typingRow}>
            <StatusDot kind="working" size={6} />
            <Text style={styles.typingText}>{t("Working…")}</Text>
          </View>
        ) : null}
      </ScrollView>

      {planText ? <TodoDock text={planText} /> : null}
    </View>
  );
}

/**
 * A finished event in the trace. The trace re-renders on every streamed chunk
 * and holds one row per thinking chunk and tool call, so without this every
 * row it had ever shown re-rendered along with the live text.
 */
const EventRow = memo(SessionMessageRow, propsEqualIgnoringFunctions);

function resultForCall(
  event: SessionMessage,
  resultByToolId: ReadonlyMap<string, { summary: string; success: boolean }>,
) {
  if (event.kind.trim().toLowerCase() !== "agent_tool_call") return undefined;
  const metadata =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>)
      : {};
  const toolId = typeof metadata.tool_id === "string" ? metadata.tool_id : "";
  return toolId ? resultByToolId.get(toolId) : undefined;
}

/**
 * Wraps the live delta buffer in a message so it can go through the same row as
 * everything else. Streaming content is never written into `message.content` on
 * the timeline itself — this object exists only for this render.
 */
function streamingMessage(turn: AgentTurnFeedItem, text: string): SessionMessage {
  return {
    messageId: `stream:${turn.agentId}:${turn.stream?.messageId ?? "live"}`,
    sessionId: "",
    teamId: "",
    senderActorId: turn.agentId,
    kind: turn.stream?.kind || "agent_reply",
    content: text,
    model: turn.stream?.model ?? "",
    turnId: "",
    replyToMessageId: "",
    metadata: null,
    // When the stream began, not "now": a fresh timestamp per render made the
    // row's props differ on every chunk even when nothing else had.
    createdAt: turn.stream?.startedAt ?? "",
    attachments: [],
  };
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xxl,
    paddingTop: spacing.sm,
  },
  emptyBlock: {
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 60,
  },
  emptyText: {
    color: colors.basalt,
    ...iosType.subheadline,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  headerButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  subtitle: {
    color: colors.slate,
    ...iosType.caption2,
  },
  title: {
    color: colors.onyx,
    ...iosType.headline,
  },
  titleBlock: {
    alignItems: "center",
    flex: 1,
  },
  typingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  typingText: {
    color: colors.slate,
    ...iosType.caption,
  },
});

export default TurnDetailScreen;
