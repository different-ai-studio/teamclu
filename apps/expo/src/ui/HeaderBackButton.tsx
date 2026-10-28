import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet } from "react-native";

import { colors } from "./theme";

/** The chevron for a `PageHeader` left slot on a pushed screen. */
export function HeaderBackButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityLabel={t("Back")}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={styles.button}
    >
      <Ionicons color={colors.onyx} name="chevron-back" size={24} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
});
