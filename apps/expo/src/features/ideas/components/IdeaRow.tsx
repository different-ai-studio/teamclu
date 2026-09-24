import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { formatRelativeAbbreviated } from "../../../lib/relative-time";
import { colors, hai, iosType, spacing } from "../../../ui/theme";
import { actorIdHash } from "../../actors/team-stats";
import { feedBodyText } from "../idea-feed";
import type { Idea, IdeaStatus } from "../idea-types";
import { IdeaFeedActions } from "./IdeaFeedActions";
import { IdeaFeedMedia } from "./IdeaFeedMedia";

/**
 * One row of the ideas list, ported from the iOS `IdeaRow` (`IdeaSheets.swift`).
 *
 * iOS states the idea's status with a small glyph in the leading gutter — a
 * check, a partial ring, an empty ring — rather than a worded pill, and shows
 * neither the description nor the workspace. That restraint is the design
 * ("不足の美"), so the port follows it.
 */

export type IdeaRowProps = {
  creatorId?: string | null;
  creatorName?: string | null;
  idea: Idea;
  /**
   * Render as a team-feed post (iOS `IdeaFeedCard`): the description under
   * the title, the idea's pictures, and the comment/like row. Off, the row
   * stays the compact one search and the archive use.
   */
  feed?: boolean;
  onOpenComments?: () => void;
  onToggleLike?: (liked: boolean) => void;
};

/** Status ink: Sage when done, Basalt in flight, Cinnabar while still open. */
function statusColor(status: IdeaStatus): string {
  if (status === "done") return hai.sage;
  if (status === "in_progress") return hai.basalt;
  return hai.cinnabar;
}

/**
 * Creator chips stay in the Hai grays — Cinnabar is reserved for the active
 * session, not for decorating avatars.
 */
function creatorAvatarColor(creatorId: string | null | undefined): string {
  if (!creatorId) return hai.slate;
  const palette = [hai.basalt, hai.slate];
  return palette[actorIdHash(creatorId) % palette.length];
}

function StatusGlyph({ status }: { status: IdeaStatus }) {
  const color = statusColor(status);

  if (status === "done") {
    return <Ionicons color={color} name="checkmark" size={11} style={styles.glyphCheck} />;
  }

  if (status === "in_progress") {
    return (
      <View style={styles.glyphSlot}>
        <View style={[styles.ringBase, { borderColor: `${color}59` }]} />
        {/* A partial ring: two transparent borders leave roughly the arc iOS
            trims to. RN has no stroke-trim, and at 8px the difference from
            iOS's 0.6 turn is not visible. */}
        <View style={[styles.ringArc, { borderColor: color }]} />
      </View>
    );
  }

  return (
    <View style={styles.glyphSlot}>
      <View style={[styles.ringOpen, { borderColor: color }]} />
    </View>
  );
}

export function IdeaRow({
  creatorId,
  creatorName,
  feed = false,
  idea,
  onOpenComments,
  onToggleLike,
}: IdeaRowProps) {
  const isDone = idea.status === "done";
  const name = creatorName?.trim() ?? "";
  const initial = name ? name.charAt(0).toUpperCase() : "·";
  const body = feedBodyText(idea);

  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        <StatusGlyph status={idea.status} />
      </View>

      <View style={styles.body}>
        <Text numberOfLines={2} style={[styles.title, isDone ? styles.titleDone : null]}>
          {feed ? body.title || idea.title : idea.title}
        </Text>

        {feed && body.description ? (
          <Text numberOfLines={6} style={styles.description}>
            {body.description}
          </Text>
        ) : null}

        {feed && idea.attachmentUrls.length > 0 ? (
          <View style={styles.media}>
            <IdeaFeedMedia urls={idea.attachmentUrls} />
          </View>
        ) : null}

        <View style={styles.creatorFooter}>
          <View
            style={[styles.creatorAvatar, { backgroundColor: creatorAvatarColor(creatorId) }]}
          >
            <Text style={styles.creatorAvatarText}>{initial}</Text>
          </View>
          <Text numberOfLines={1} style={styles.creatorName}>
            {name || "Unknown"}
          </Text>
          <View style={styles.creatorSpacer} />
          <Text style={styles.updatedAt}>
            {formatRelativeAbbreviated(idea.updatedAt || idea.createdAt)}
          </Text>
        </View>

        {feed ? (
          <IdeaFeedActions
            idea={idea}
            onOpenComments={onOpenComments}
            onToggleLike={onToggleLike}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    gap: 6,
  },
  creatorAvatar: {
    alignItems: "center",
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    width: 18,
  },
  creatorAvatarText: {
    color: "#FFFFFF",
    fontSize: 9,
    fontWeight: "700",
  },
  creatorFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingTop: 2,
  },
  creatorName: {
    color: colors.onyx,
    flexShrink: 1,
    ...iosType.caption,
  },
  creatorSpacer: {
    flex: 1,
    minWidth: 8,
  },
  description: {
    color: colors.onyx,
    ...iosType.body,
  },
  glyphCheck: {
    fontWeight: "900",
  },
  glyphSlot: {
    alignItems: "center",
    height: 14,
    justifyContent: "center",
    width: 14,
  },
  gutter: {
    alignItems: "center",
    paddingTop: 4,
    width: 14,
  },
  media: {
    paddingTop: 2,
  },
  ringArc: {
    borderBottomColor: "transparent",
    borderRadius: 4,
    borderRightColor: "transparent",
    borderWidth: 1.8,
    height: 8,
    position: "absolute",
    transform: [{ rotate: "-45deg" }],
    width: 8,
  },
  ringBase: {
    borderRadius: 4,
    borderWidth: 1.4,
    height: 8,
    position: "absolute",
    width: 8,
  },
  ringOpen: {
    borderRadius: 4,
    borderWidth: 1.5,
    height: 8,
    width: 8,
  },
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
  },
  title: {
    color: colors.onyx,
    ...iosType.body,
  },
  titleDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
  },
  updatedAt: {
    color: colors.slate,
    ...iosType.captionMono,
  },
});

export default IdeaRow;
