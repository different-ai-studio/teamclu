import { Image, StyleSheet, Text, View } from "react-native";

import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, iosType, radii, spacing } from "../../../ui/theme";
import { type Actor, isActorOnline } from "../actor-types";
import { actorIdHash } from "../team-stats";

const HUMAN_PALETTE = [hai.basalt, hai.slate, hai.sage, hai.onyx];

/**
 * Agent avatar ink, keyed on the backend. Per "spare the vermillion" only
 * Claude earns Cinnabar; OpenCode gets Sage and everything else sits in Basalt.
 * Mirrors `MemberListContent.ActorRow.avatarStyle`.
 */
function agentForeground(defaultAgentType: string | null | undefined): string {
  switch (defaultAgentType) {
    case "claude":
    case "claude_code":
      return hai.cinnabar;
    case "opencode":
      return hai.sage;
    case "codex":
      return hai.basalt;
    default:
      return hai.basalt;
  }
}

/**
 * Deterministic per-actor session count. This is placeholder data on iOS too
 * (`MemberListContent.ActorRow.mockActiveSessions`) — stable per actor so it
 * doesn't churn between renders, and skewed higher for online actors. Ported as
 *-is so the two apps agree until a real aggregate lands.
 */
function mockActiveSessions(actorId: string, online: boolean): number {
  const buckets = online ? [0, 1, 1, 1, 2, 2, 3] : [0, 0, 0, 0, 1, 1];
  return buckets[actorIdHash(actorId) % buckets.length];
}

type AvatarStyle = { background: string; foreground: string; isSquare: boolean };

function avatarInitials(displayName: string): string {
  const parts = displayName
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return displayName.slice(0, 1).toUpperCase();
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

function deriveAvatar(actor: Actor, isMe: boolean): AvatarStyle {
  if (actor.actorType === "agent") {
    return {
      background: hai.pebble,
      foreground: agentForeground(actor.defaultAgentType),
      isSquare: true,
    };
  }
  if (isMe) {
    return { background: hai.cinnabar, foreground: "#FFFFFF", isSquare: false };
  }
  const background = HUMAN_PALETTE[actorIdHash(actor.actorId) % HUMAN_PALETTE.length];
  return { background, foreground: "#FFFFFF", isSquare: false };
}

type Tag = { text: string; foreground: string; background: string };

function deriveTag(actor: Actor, isMe: boolean): Tag | null {
  if (isMe) {
    return {
      text: "YOU",
      foreground: hai.cinnabar,
      background: "rgba(184,75,54,0.10)",
    };
  }
  if (actor.role === "owner") {
    return { text: "OWNER", foreground: hai.basalt, background: hai.pebble };
  }
  if (actor.actorType === "agent") {
    return { text: "AGENT", foreground: hai.basalt, background: hai.pebble };
  }
  return null;
}

/** Mirrors iOS `CachedActor.roleLabel`. */
function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "member":
      return "Member";
    default:
      return "—";
  }
}

function agentKindLabel(defaultAgentType: string | null | undefined): string {
  switch (defaultAgentType) {
    case "claude":
    case "claude_code":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    default:
      return "Agent";
  }
}

function deriveSubtitle(actor: Actor, isMe: boolean): string {
  if (isMe) return "you";
  if (actor.actorType === "member") return roleLabel(actor.role);
  if (actor.actorType === "agent") {
    const kind = agentKindLabel(actor.defaultAgentType);
    const status = actor.agentStatus?.trim() ?? "";
    return status ? `${kind} · ${status}` : kind;
  }
  return "External";
}

export type ActorRowProps = {
  actor: Actor;
  isMe?: boolean;
};

function agentKindGlyph(actor: Actor): string | null {
  if (actor.actorType !== "agent") return null;
  switch (actor.agentKind) {
    case "claude":
      return "CC";
    case "opencode":
      return "OC";
    case "codex":
      return "CX";
    default:
      return null;
  }
}

export function ActorRow({ actor, isMe = false }: ActorRowProps) {
  const avatar = deriveAvatar(actor, isMe);
  const tag = deriveTag(actor, isMe);
  const subtitle = deriveSubtitle(actor, isMe);
  const initials = agentKindGlyph(actor) ?? avatarInitials(actor.displayName);
  const online = isActorOnline(actor);
  const subtitleStyle = isMe || actor.actorType !== "member" ? styles.subtitleMono : styles.subtitle;
  const activeSessions = mockActiveSessions(actor.actorId, online);

  return (
    <View style={styles.row}>
      <View style={styles.avatarTile}>
        <View
          style={[
            styles.avatar,
            { backgroundColor: avatar.background, borderRadius: avatar.isSquare ? 10 : 999 },
            avatar.isSquare ? styles.avatarAgentBorder : null,
          ]}
        >
          {actor.avatarUrl ? (
            <Image
              accessibilityRole="image"
              source={{ uri: actor.avatarUrl }}
              style={[styles.avatarImage, { borderRadius: avatar.isSquare ? 10 : 999 }]}
            />
          ) : (
            <Text style={[styles.avatarText, { color: avatar.foreground }]}>{initials}</Text>
          )}
        </View>
        {/* iOS pins the online pip to the avatar's bottom-trailing corner with a
            Mist ring, so it reads as a pip on the paper rather than a halo. */}
        {online ? <StatusDot kind="active" size={11} style={styles.onlinePip} /> : null}
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>
            {actor.displayName}
          </Text>
          {tag ? (
            <View style={[styles.tag, { backgroundColor: tag.background }]}>
              <Text style={[styles.tagText, { color: tag.foreground }]}>{tag.text}</Text>
            </View>
          ) : null}
        </View>
        <Text numberOfLines={1} style={subtitleStyle}>
          {subtitle}
        </Text>
      </View>

      {activeSessions > 0 ? (
        <View style={styles.activeChip}>
          <StatusDot
            breathing={online}
            color={online ? hai.sage : hai.slate}
            size={6}
          />
          <Text style={styles.activeChipCount}>{activeSessions}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  activeChip: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
  activeChipCount: {
    color: colors.basalt,
    ...iosType.caption,
  },
  avatar: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    overflow: "hidden",
    width: 40,
  },
  avatarAgentBorder: {
    borderColor: colors.hairline,
    borderWidth: 0.5,
  },
  avatarTile: {
    height: 40,
    width: 40,
  },
  onlinePip: {
    borderColor: colors.mist,
    borderWidth: 2.5,
    bottom: -1,
    height: 16,
    position: "absolute",
    right: -1,
    width: 16,
  },
  avatarImage: {
    height: "100%",
    width: "100%",
  },
  avatarText: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
  },
  subtitle: {
    color: colors.slate,
    ...iosType.caption,
  },
  subtitleMono: {
    color: colors.slate,
    ...iosType.captionMono,
  },
  tag: {
    alignItems: "center",
    borderRadius: radii.chip,
    height: 16,
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  tagText: {
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  title: {
    color: colors.onyx,
    flexShrink: 1,
    ...iosType.body,
    fontWeight: "600",
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
});

export default ActorRow;
