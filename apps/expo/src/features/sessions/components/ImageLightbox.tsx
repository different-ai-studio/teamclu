import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { hai } from "../../../ui/theme";
import { ZoomableImage } from "./ZoomableImage";

export type ImageLightboxProps = {
  onClose: () => void;
  url: string | null;
};

/**
 * Full-screen image viewer used when the user taps an image
 * attachment in the message feed. Mirrors iOS `ImageLightbox`: black
 * backdrop, dismiss on a single tap, close affordance top-left. Pinch,
 * double-tap and drag zoom the image (iOS #1709 `ZoomableContainer`).
 */
export function ImageLightbox({ onClose, url }: ImageLightboxProps) {
  const { t } = useTranslation();
  if (!url) return null;
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      {/* A modal renders outside the app's gesture root; it needs its own. */}
      <GestureHandlerRootView style={styles.backdrop}>
        <ZoomableImage onTap={onClose} uri={url} />
        <Pressable
          accessibilityLabel={t("Close")}
          accessibilityRole="button"
          hitSlop={12}
          onPress={onClose}
          style={styles.closeButton}
        >
          <Ionicons color={hai.paper} name="close" size={24} />
        </Pressable>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.92)",
    flex: 1,
    justifyContent: "center",
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    left: 16,
    position: "absolute",
    top: 48,
    width: 36,
  },
});

export default ImageLightbox;
