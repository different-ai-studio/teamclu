import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { Idea } from "../../ideas/idea-types";

/**
 * Second-level destination from a person's detail screen: the ideas behind the
 * IDEAS number, in the same order and by the same rule (`memberIdeas`). Ported
 * from iOS `ActorIdeasListView`.
 *
 * Unlike iOS, rows open the idea: Expo's idea detail is a standalone route that
 * needs only the idea id, so there is no cross-tab hand-off to build.
 */
export type ActorIdeasListScreenProps = {
  actorName: string;
  ideas: ReadonlyArray<Idea>;
  isLoading: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSelectIdea?: (ideaId: string) => void;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ActorIdeasListScreen({
  actorName,
  errorMessage,
  ideas,
  isLoading,
  onClose,
  onSelectIdea,
}: ActorIdeasListScreenProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Ideas")}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.scopeNote}>
          {t("Posted by {{value}}. Archived ideas are not counted.", { value: actorName })}
        </Text>

        {errorMessage ? (
          <View style={styles.card}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : isLoading ? (
          <View style={styles.stateRow}>
            <ActivityIndicator color={colors.slate} />
          </View>
        ) : ideas.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("No ideas yet")}</Text>
            <Text style={styles.stateBody}>
              {t("{{value}} hasn't posted anything to the board.", { value: actorName })}
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            {ideas.map((idea, index) => (
              <View key={idea.ideaId}>
                <Pressable
                  accessibilityRole={onSelectIdea ? "button" : undefined}
                  disabled={!onSelectIdea}
                  onPress={onSelectIdea ? () => onSelectIdea(idea.ideaId) : undefined}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && onSelectIdea ? styles.rowPressed : null,
                  ]}
                >
                  <View style={styles.rowBody}>
                    <Text numberOfLines={2} style={styles.rowTitle}>
                      {idea.title.trim() || t("Untitled idea")}
                    </Text>
                    {idea.description.trim() ? (
                      <Text numberOfLines={2} style={styles.rowSubtitle}>
                        {idea.description.trim()}
                      </Text>
                    ) : null}
                    <Text style={styles.rowMeta}>{formatDate(idea.createdAt)}</Text>
                  </View>
                  {onSelectIdea ? (
                    <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                  ) : null}
                </Pressable>
                {index < ideas.length - 1 ? <Hairline /> : null}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  errorText: {
    color: hai.cinnabarDeep,
    padding: spacing.md,
    ...typography.secondaryBody,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowMeta: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  rowSubtitle: {
    color: colors.slate,
    ...typography.caption,
  },
  rowTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  scopeNote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  stateBlock: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  stateRow: {
    paddingVertical: spacing.lg,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});

export default ActorIdeasListScreen;
