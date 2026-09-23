import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { hai, iosType } from "../../../ui/theme";
import { feedCountLabel } from "../idea-feed";
import type { Idea } from "../idea-types";

/**
 * The comment count and the heart under a feed post, ported from the action
 * row of iOS `IdeaFeedCard`. Zero counts print nothing — the glyph alone says
 * "nobody yet". Coral goes on the heart glyph only, and only when liked.
 */
export function IdeaFeedActions({
  idea,
  onOpenComments,
  onToggleLike,
}: {
  idea: Pick<Idea, "ideaId" | "commentCount" | "likeCount" | "likedByMe">;
  onOpenComments?: () => void;
  onToggleLike?: (liked: boolean) => void;
}) {
  const { t } = useTranslation();
  const comments = feedCountLabel(idea.commentCount);
  const likes = feedCountLabel(idea.likeCount);

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={t("Comments")}
        accessibilityRole="button"
        disabled={!onOpenComments}
        hitSlop={8}
        onPress={onOpenComments}
        style={styles.action}
      >
        <Ionicons color={hai.slate} name="chatbubble-outline" size={15} />
        {comments ? <Text style={styles.count}>{comments}</Text> : null}
      </Pressable>

      <Pressable
        accessibilityLabel={idea.likedByMe ? t("Unlike") : t("Like")}
        accessibilityRole="button"
        accessibilityState={{ selected: idea.likedByMe }}
        disabled={!onToggleLike}
        hitSlop={8}
        onPress={() => onToggleLike?.(!idea.likedByMe)}
        style={styles.action}
        testID={`idea.likeButton.${idea.ideaId}`}
      >
        <Ionicons
          color={idea.likedByMe ? hai.cinnabar : hai.slate}
          name={idea.likedByMe ? "heart" : "heart-outline"}
          size={16}
        />
        {likes ? <Text style={styles.count}>{likes}</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    minHeight: 24,
  },
  count: {
    color: hai.slate,
    fontVariant: ["tabular-nums"],
    ...iosType.caption,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 28,
    paddingTop: 2,
  },
});
