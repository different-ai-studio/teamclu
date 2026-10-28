import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { impactLight } from "../../../lib/haptics";
import { colors, typography } from "../../../ui/theme";

export type HomeComposerBarProps = {
  /** The default agent's name for the placeholder; null when there is none yet. */
  agentName: string | null;
  onCompose: () => void;
  onVoice: () => void;
};

/**
 * The bar pinned under the session list (iOS `HomeComposerBar`, #1752): a
 * field that opens New Session and a mic that opens voice capture. It replaced
 * the tab bar, and with it the header's new-session button and the Voice tab.
 */
export function HomeComposerBar({ agentName, onCompose, onVoice }: HomeComposerBarProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View
      // Into the home-indicator reserve, as iOS does, so the bar sits where the
      // session composer rests and does not jump when a session pushes in.
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom - 12, 8) }]}
      testID="sessions.composerBar"
    >
      <Pressable
        accessibilityLabel={t("New Session")}
        accessibilityRole="button"
        onPress={onCompose}
        style={({ pressed }) => [styles.field, pressed ? styles.pressed : null]}
        testID="sessions.composerField"
      >
        <Text numberOfLines={1} style={styles.placeholder}>
          {agentName ? t("Message {{value}}…", { value: agentName }) : t("Message")}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={t("Voice")}
        accessibilityRole="button"
        onPress={() => {
          impactLight();
          onVoice();
        }}
        style={({ pressed }) => [styles.mic, pressed ? styles.pressed : null]}
        testID="sessions.voiceButton"
      >
        <Ionicons color={colors.onyx} name="mic-outline" size={22} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  field: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    height: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  mic: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  placeholder: {
    color: colors.slate,
    ...typography.body,
  },
  pressed: {
    opacity: 0.8,
  },
});
