import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, iosType, spacing } from "../../../ui/theme";
import { matchesAnyField } from "../../search/search-matcher";
import type { SessionSummary } from "../session-types";

/**
 * Where to forward the selected messages (iOS #1709 multi-select): another
 * session of this team. The forward is plain text that mentions no one, so
 * the agents there take it in as context and do not reply.
 */
export function ForwardTargetSheet({
  sessions,
  isLoading,
  onCancel,
  onSelect,
}: {
  /** Other sessions of this team, newest first; null while loading. */
  sessions: readonly SessionSummary[] | null;
  isLoading: boolean;
  onCancel: () => void;
  onSelect: (session: SessionSummary) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () =>
      (sessions ?? []).filter((session) =>
        query.trim() ? matchesAnyField([session.title, session.summary], query) : true,
      ),
    [query, sessions],
  );
  return (
    <View style={styles.screen}>
      <GlassHeader>
        <Pressable hitSlop={8} onPress={onCancel} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {t("Forward to")}
        </Text>
        <View style={styles.headerSlot} />
      </GlassHeader>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.search}>
          <Ionicons color={colors.slate} name="search" size={14} />
          <TextInput
            autoCapitalize="none"
            onChangeText={setQuery}
            placeholder={t("Search sessions")}
            placeholderTextColor={colors.slate}
            style={styles.searchInput}
            value={query}
          />
        </View>
        {isLoading ? <ActivityIndicator color={colors.slate} /> : null}
        {!isLoading && visible.length === 0 ? (
          <Text style={styles.caption}>{t("No other sessions")}</Text>
        ) : null}
        <View style={styles.card}>
          {visible.map((session, index) => (
            <View key={session.sessionId}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onSelect(session)}
                style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
              >
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {session.title.trim() || t("Untitled session")}
                </Text>
              </Pressable>
              {index < visible.length - 1 ? <Hairline /> : null}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    color: colors.basalt,
    paddingHorizontal: spacing.lg,
    ...iosType.footnote,
  },
  card: {
    backgroundColor: colors.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.md,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    flexShrink: 1,
    ...iosType.headline,
  },
  pressed: {
    backgroundColor: colors.mist,
  },
  row: {
    backgroundColor: colors.paper,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  rowTitle: {
    color: colors.onyx,
    ...iosType.body,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  search: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderRadius: 10,
    flexDirection: "row",
    gap: 6,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
});
