import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { actorAvatarColor } from "../../../lib/actor-color";
import { formatRelativeTime } from "../../../lib/relative-time";
import { AgentBadge } from "../../../ui/atoms/AgentBadge";
import { AvatarStack, type AvatarEntry } from "../../../ui/atoms/AvatarStack";
import { UnreadDot } from "../../../ui/atoms/UnreadDot";
import { colors, hai, iosType, spacing } from "../../../ui/theme";
import type { SessionLiveActivity } from "../live-activity";
import type { SessionSummary } from "../session-types";

/**
 * One row of the sessions list, ported from the iOS `AgentRowView`
 * (`SessionListHelpers.swift`). Structure, type sizes and the meta strip follow
 * that source; see `docs/expo-ios-parity-audit.md` for why the type scale is
 * read from `iosType` rather than this app's own smaller scale.
 */

/** `Amux_AgentType` raw values, as carried on the runtime attachment. */
const AGENT_TYPE_CLAUDE = 1;
const AGENT_TYPE_OPENCODE = 2;
const AGENT_TYPE_CODEX = 3;

/** Runtime status raw values (`AgentAttachment.status`). */
const STATUS_STARTING = 1;
const STATUS_RUNNING = 2;
const STATUS_STOPPED = 5;

export type SessionRowRuntime = {
  /** `AgentAttachment.status`; 0/undefined means no attachment — a cold session. */
  status?: number;
  agentType?: number;
  statusLabel?: string;
};

type SessionRowProps = {
  /** Per-actor glyph override (e.g. "CC"/"OC"/"CX" for known agent kinds). */
  actorGlyphById?: ReadonlyMap<string, string>;
  isActive?: boolean;
  isMuted?: boolean;
  isPinned?: boolean;
  /**
   * From the session's live stream (iOS #1567): an agent is working here, or
   * is waiting on you. Overrides the runtime colour while lit.
   */
  activity?: SessionLiveActivity;
  /** Live runtime attachment for this session's agent, when known. */
  runtime?: SessionRowRuntime | null;
  session: SessionSummary;
  /** Workspace/worktree name shown at the head of the meta strip. */
  workspaceName?: string;
  onLongPress?: (session: SessionSummary) => void;
  onPress?: (session: SessionSummary) => void;
  unreadCount?: number;
};

const BADGE_INDENT = 38;

type Badge = { glyph: string; fg: string };

/**
 * Pebble-tinted badge with a backend-keyed foreground. Per "spare the
 * vermillion" only the Claude variant gets Cinnabar; OpenCode/Codex sit in
 * Basalt, and an unknown backend drops to Slate.
 */
function agentBadge(
  session: SessionSummary,
  runtime: SessionRowRuntime | null | undefined,
  actorGlyphById?: ReadonlyMap<string, string>,
): Badge {
  switch (runtime?.agentType) {
    case AGENT_TYPE_CLAUDE:
      return { glyph: "CC", fg: hai.cinnabar };
    case AGENT_TYPE_OPENCODE:
      return { glyph: "OC", fg: hai.basalt };
    case AGENT_TYPE_CODEX:
      return { glyph: "CX", fg: hai.basalt };
    default:
      return { glyph: fallbackGlyph(session, actorGlyphById), fg: hai.slate };
  }
}

function fallbackGlyph(
  session: SessionSummary,
  actorGlyphById?: ReadonlyMap<string, string>,
): string {
  for (const actorId of session.participantActorIds) {
    const glyph = actorGlyphById?.get(actorId);
    if (glyph && glyph.length > 1) return glyph;
  }
  const source = (session.title || session.sessionId).trim();
  const last = source.split("/").pop() ?? source;
  if (!last) return "·";
  return last.charAt(0).toUpperCase() || "·";
}

function statusDotColor(runtime: SessionRowRuntime | null | undefined): string {
  switch (runtime?.status) {
    case STATUS_RUNNING:
      return hai.sage;
    case STATUS_STARTING:
      return hai.slate;
    case STATUS_STOPPED:
      // Onyx at 25% — a stopped session reads as spent, not idle.
      return "rgba(34,32,29,0.25)";
    default:
      return hai.slate;
  }
}

function buildAvatars(
  session: SessionSummary,
  actorGlyphById?: ReadonlyMap<string, string>,
): AvatarEntry[] {
  const ids = session.participantActorIds.length
    ? session.participantActorIds.slice(0, 3)
    : [session.createdBy].filter(Boolean);

  return ids.map((id) => {
    const palette = actorAvatarColor(id);
    const override = actorGlyphById?.get(id);
    const initials =
      override ?? (id.replace(/[^A-Za-z0-9一-龥]/g, "").slice(0, 2) || "·");
    return { id, initials, bg: palette.bg, fg: palette.fg };
  });
}

export function SessionRow({
  actorGlyphById,
  isActive = false,
  isMuted = false,
  isPinned = false,
  activity = "quiet",
  runtime,
  session,
  workspaceName = "",
  onLongPress,
  onPress,
  unreadCount = 0,
}: SessionRowProps) {
  const title = session.title.trim() || "Untitled session";
  const lastMessage = session.lastMessagePreview.trim();
  const timeLabel = formatRelativeTime(session.lastMessageAt || session.createdAt);
  const isUnread = unreadCount > 0 || Boolean(session.hasUnread);
  const isRunning = runtime?.status === STATUS_RUNNING;
  const isStopped = runtime?.status === STATUS_STOPPED;
  const badge = agentBadge(session, runtime, actorGlyphById);
  const statusLabel = runtime?.status && runtime.status !== 0 ? runtime.statusLabel ?? "" : "";

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      delayLongPress={350}
      disabled={!onPress}
      onLongPress={onLongPress ? () => onLongPress(session) : undefined}
      onPress={() => onPress?.(session)}
      style={({ pressed }) => [
        styles.row,
        isActive ? styles.activeRow : null,
        pressed && onPress ? styles.pressed : null,
      ]}
    >
      <View style={styles.headerRow}>
        <AgentBadge
          bg={colors.pebble}
          breathing={isRunning || activity !== "quiet"}
          dotColor={
            activity === "needsAttention"
              ? hai.cinnabar
              : activity === "running"
                ? hai.sage
                : statusDotColor(runtime)
          }
          fg={badge.fg}
          label={badge.glyph}
        />
        <Text
          numberOfLines={1}
          style={[styles.title, isStopped ? styles.titleStopped : null]}
        >
          {title}
        </Text>
        {/* Quiet markers — bare Slate glyphs, no capsule, per the Hai
            restraint rule that status whispers rather than shouts. */}
        {isPinned ? (
          <Ionicons color={colors.slate} name="pin" size={11} />
        ) : null}
        {isMuted ? (
          <Ionicons
            accessibilityLabel="Muted"
            color={colors.slate}
            name="notifications-off"
            size={11}
          />
        ) : null}
        <UnreadDot hidden={!isUnread} />
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      {lastMessage ? (
        <Text numberOfLines={1} style={styles.summary}>
          {lastMessage}
        </Text>
      ) : null}

      <View style={styles.metaStrip}>
        {workspaceName ? (
          <Text numberOfLines={1} style={styles.workspace}>
            {workspaceName}
          </Text>
        ) : null}
        {workspaceName && statusLabel ? <View style={styles.metaSeparator} /> : null}
        {statusLabel ? (
          <Text
            numberOfLines={1}
            style={[
              styles.statusLabel,
              isRunning ? styles.statusLabelRunning : null,
            ]}
          >
            {statusLabel}
          </Text>
        ) : null}
        <View style={styles.metaSpacer} />
        <AvatarStack avatars={buildAvatars(session, actorGlyphById)} max={3} size={22} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  activeRow: {
    backgroundColor: colors.paper,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  metaSeparator: {
    backgroundColor: "rgba(166,163,156,0.5)",
    borderRadius: 1.5,
    height: 3,
    width: 3,
  },
  metaSpacer: {
    flex: 1,
  },
  metaStrip: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingLeft: BADGE_INDENT,
  },
  pressed: {
    backgroundColor: "rgba(34,32,29,0.03)",
  },
  row: {
    backgroundColor: "transparent",
    gap: 6,
    paddingHorizontal: spacing.lg,
    // iOS uses `.padding(.vertical, 6)`; the List supplies the rest.
    paddingVertical: 6,
  },
  statusLabel: {
    color: colors.basalt,
    ...iosType.caption,
    fontWeight: "500",
  },
  statusLabelRunning: {
    color: hai.sage,
  },
  summary: {
    color: colors.basalt,
    paddingLeft: BADGE_INDENT,
    ...iosType.subheadline,
  },
  time: {
    color: colors.slate,
    ...iosType.caption,
  },
  title: {
    color: colors.onyx,
    flex: 1,
    ...iosType.body,
    fontWeight: "600",
  },
  titleStopped: {
    color: colors.basalt,
  },
  workspace: {
    color: colors.slate,
    ...iosType.captionMono,
  },
});
