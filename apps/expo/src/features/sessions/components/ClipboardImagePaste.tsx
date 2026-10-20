import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, spacing } from "../../../ui/theme";

const IMAGE_OPTIONS = { format: "jpeg" as const, jpegQuality: 0.85 };

/**
 * Whether the clipboard holds an image, rechecked while `active` (the input is
 * focused), on clipboard changes and on return to the foreground. Only asks
 * *whether* there is an image — reading it waits for the user's tap, so iOS
 * never shows its "Allow Paste" prompt for a check.
 */
export function useClipboardHasImage(active: boolean): boolean {
  const [hasImage, setHasImage] = useState(false);
  useEffect(() => {
    if (!active) {
      setHasImage(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      void Clipboard.hasImageAsync()
        .then((value) => {
          if (!cancelled) setHasImage(value);
        })
        .catch(() => {});
    };
    check();
    const clipboard = Clipboard.addClipboardListener(check);
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") check();
    });
    return () => {
      cancelled = true;
      Clipboard.removeClipboardListener(clipboard);
      appState.remove();
    };
  }, [active]);
  return hasImage;
}

/**
 * "Paste image" above the composer (iOS #1709). On iOS 16+ this is the system
 * paste control, which reads the clipboard on the user's own tap without the
 * permission prompt; elsewhere a plain button reads it.
 */
export function ClipboardImagePasteButton({
  onPaste,
}: {
  /** Base64 JPEG (possibly a data URI) of the pasted image. */
  onPaste: (data: string) => void;
}) {
  const { t } = useTranslation();
  if (Platform.OS === "ios" && Clipboard.isPasteButtonAvailable) {
    return (
      <View style={styles.row} testID="composer.pasteImage">
        <Clipboard.ClipboardPasteButton
          acceptedContentTypes={["image"]}
          displayMode="iconAndLabel"
          imageOptions={IMAGE_OPTIONS}
          onPress={(data) => {
            if (data.type === "image" && data.data) onPaste(data.data);
          }}
          style={styles.systemButton}
        />
        <Text style={styles.hint}>{t("Image on clipboard")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.row} testID="composer.pasteImage">
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void Clipboard.getImageAsync(IMAGE_OPTIONS)
            .then((image) => {
              if (image?.data) onPaste(image.data);
            })
            .catch(() => {});
        }}
        style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
      >
        <Ionicons color={hai.mist} name="clipboard-outline" size={14} />
        <Text style={styles.buttonLabel}>{t("Paste image")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: hai.onyx,
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  buttonLabel: {
    color: hai.mist,
    fontSize: 13,
    fontWeight: "500",
  },
  hint: {
    color: colors.slate,
    fontSize: 12,
  },
  pressed: {
    opacity: 0.7,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  systemButton: {
    height: 40,
    width: 160,
  },
});
