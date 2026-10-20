import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, spacing } from "../../../ui/theme";

/**
 * Takes the composer's place while messages are being selected (iOS #1709
 * multi-select): how many, then copy / forward / delete / cancel.
 */
export function MessageSelectionBar({
  count,
  canDelete,
  onCopy,
  onForward,
  onDelete,
  onCancel,
}: {
  count: number;
  canDelete: boolean;
  onCopy: () => void;
  onForward: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const hasSelection = count > 0;
  const action = (
    label: string,
    icon: keyof typeof Ionicons.glyphMap,
    onPress: () => void,
    enabled: boolean,
    destructive = false,
  ) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={!enabled}
      hitSlop={6}
      onPress={onPress}
      style={styles.action}
    >
      <Ionicons
        color={!enabled ? colors.slate : destructive ? hai.cinnabar : hai.onyx}
        name={icon}
        size={20}
      />
      <Text style={[styles.actionLabel, !enabled ? styles.disabled : null]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.bar} testID="session.selectionBar">
      <Text style={styles.count}>{t("{{value}} selected", { value: count })}</Text>
      <View style={styles.actions}>
        {action(t("Copy"), "copy-outline", onCopy, hasSelection)}
        {action(t("Forward"), "arrow-redo-outline", onForward, hasSelection)}
        {action(t("Delete"), "trash-outline", onDelete, hasSelection && canDelete, true)}
        <Pressable hitSlop={6} onPress={onCancel} style={styles.cancel}>
          <Text style={styles.cancelLabel}>{t("Cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    gap: 2,
    minWidth: 44,
  },
  actionLabel: {
    color: hai.onyx,
    fontSize: 11,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  bar: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  cancel: {
    marginLeft: spacing.xs,
  },
  cancelLabel: {
    color: hai.cinnabar,
    fontSize: 15,
    fontWeight: "500",
  },
  count: {
    color: colors.slate,
    fontSize: 13,
  },
  disabled: {
    color: colors.slate,
  },
});
