import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, iosType, spacing } from "../../../ui/theme";

/** Product name shown in onboarding copy (iOS reads it from the bundle). */
export const APP_NAME = "TeamClu";

/** One option on the choice / no-team screens. iOS `OnboardingOptionRow`. */
export function OnboardingOptionRow({
  caption,
  disabled,
  icon,
  isPrimary,
  onPress,
  testID,
  title,
}: {
  caption: string;
  disabled?: boolean;
  icon: ComponentProps<typeof Ionicons>["name"];
  isPrimary?: boolean;
  onPress: () => void;
  testID?: string;
  title: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
      testID={testID}
    >
      <View style={styles.iconWrap}>
        <Ionicons
          color={isPrimary ? colors.cinnabar : colors.basalt}
          name={icon}
          size={18}
        />
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.caption}>{caption}</Text>
      </View>
      <Ionicons color={colors.slate} name="chevron-forward" size={14} />
    </Pressable>
  );
}

/** Inline error note. iOS `OnboardingErrorNote`. */
export function OnboardingErrorNote({ message }: { message: string }) {
  return (
    <View style={styles.errorNote}>
      <Ionicons color={colors.cinnabar} name="warning" size={16} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    gap: 3,
  },
  caption: {
    color: colors.basalt,
    ...iosType.caption,
  },
  disabled: {
    opacity: 0.5,
  },
  errorNote: {
    alignItems: "flex-start",
    backgroundColor: colors.pebble,
    borderRadius: 4,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorText: {
    color: colors.onyx,
    flex: 1,
    ...iosType.footnote,
  },
  iconWrap: {
    alignItems: "center",
    width: 28,
  },
  pressed: {
    opacity: 0.85,
  },
  row: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 14,
    padding: spacing.lg,
  },
  title: {
    color: colors.onyx,
    ...iosType.body,
    fontWeight: "600",
  },
});
