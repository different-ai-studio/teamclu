import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, hai, spacing } from "../../../ui/theme";

/**
 * Find in this session (iOS #1709 `SessionSearchBar`): the query, "n/m",
 * older / newer, and Done. Searches only what is loaded on this device.
 */
export function SessionSearchBar({
  query,
  onChangeQuery,
  matchCount,
  currentIndex,
  onOlder,
  onNewer,
  onDone,
}: {
  query: string;
  onChangeQuery: (value: string) => void;
  matchCount: number;
  /** 0-based position of the current match, or -1. */
  currentIndex: number;
  onOlder: () => void;
  onNewer: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const hasQuery = query.trim().length > 0;
  const canOlder = matchCount > 0 && currentIndex > 0;
  const canNewer = matchCount > 0 && currentIndex < matchCount - 1;
  return (
    <View style={styles.bar} testID="session.searchBar">
      <View style={styles.field}>
        <Ionicons color={colors.slate} name="search" size={14} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onChangeText={onChangeQuery}
          placeholder={t("Search in conversation")}
          placeholderTextColor={colors.slate}
          returnKeyType="search"
          style={styles.input}
          testID="session.searchField"
          value={query}
        />
        {hasQuery ? (
          <Text style={styles.count} testID="session.searchCount">
            {matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : t("No results")}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={t("Previous match")}
        disabled={!canOlder}
        hitSlop={6}
        onPress={onOlder}
        style={styles.navButton}
      >
        <Ionicons color={canOlder ? hai.onyx : colors.slate} name="chevron-up" size={18} />
      </Pressable>
      <Pressable
        accessibilityLabel={t("Next match")}
        disabled={!canNewer}
        hitSlop={6}
        onPress={onNewer}
        style={styles.navButton}
      >
        <Ionicons color={canNewer ? hai.onyx : colors.slate} name="chevron-down" size={18} />
      </Pressable>
      <Pressable hitSlop={6} onPress={onDone} testID="session.searchDone">
        <Text style={styles.done}>{t("Done")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  count: {
    color: colors.slate,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  done: {
    color: hai.cinnabar,
    fontSize: 15,
    fontWeight: "500",
  },
  field: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderRadius: 10,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  input: {
    color: hai.onyx,
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  navButton: {
    padding: 2,
  },
});
