import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Animated, Image, StyleSheet, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

export function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** How far a `scale`d image may pan before its edge leaves the screen edge. */
export function panBound(extent: number, scale: number): number {
  return Math.max(0, (extent * (scale - 1)) / 2);
}

function clamp(value: number, bound: number): number {
  return Math.min(bound, Math.max(-bound, value));
}

/**
 * Full-screen image with pinch zoom (1–5×), double-tap between fit and 2.5×,
 * and drag while zoomed (iOS #1709 `ZoomableContainer`). A single tap is
 * `onTap` — the lightbox closes on it. At fit size there is nothing to drag,
 * so swipes pass through.
 */
export function ZoomableImage({ uri, onTap }: { uri: string; onTap?: () => void }) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  // The animated values are write-only from JS; mirror them here.
  const current = useRef({ scale: 1, x: 0, y: 0, startScale: 1, startX: 0, startY: 0 }).current;

  const settle = (nextScale: number, x: number, y: number, animated: boolean) => {
    current.scale = nextScale;
    current.x = x;
    current.y = y;
    if (!animated) {
      scale.setValue(nextScale);
      translateX.setValue(x);
      translateY.setValue(y);
      return;
    }
    Animated.parallel([
      Animated.spring(scale, { toValue: nextScale, useNativeDriver: true, bounciness: 0 }),
      Animated.spring(translateX, { toValue: x, useNativeDriver: true, bounciness: 0 }),
      Animated.spring(translateY, { toValue: y, useNativeDriver: true, bounciness: 0 }),
    ]).start();
  };

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      current.startScale = current.scale;
    })
    .onUpdate((event) => {
      const next = clampScale(current.startScale * event.scale);
      current.scale = next;
      scale.setValue(next);
    })
    .onEnd(() => {
      // Keep the image covering the screen edge it was pulled from.
      const x = clamp(current.x, panBound(width, current.scale));
      const y = clamp(current.y, panBound(height, current.scale));
      settle(current.scale, current.scale <= 1.01 ? 0 : x, current.scale <= 1.01 ? 0 : y, true);
    });

  const pan = Gesture.Pan()
    .runOnJS(true)
    .averageTouches(true)
    .onStart(() => {
      current.startX = current.x;
      current.startY = current.y;
    })
    .onUpdate((event) => {
      if (current.scale <= 1) return;
      const x = clamp(current.startX + event.translationX, panBound(width, current.scale));
      const y = clamp(current.startY + event.translationY, panBound(height, current.scale));
      current.x = x;
      current.y = y;
      translateX.setValue(x);
      translateY.setValue(y);
    });

  const doubleTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(2)
    .onEnd((_event, success) => {
      if (!success) return;
      if (current.scale > 1) settle(1, 0, 0, true);
      else settle(DOUBLE_TAP_SCALE, 0, 0, true);
    });

  const singleTap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((_event, success) => {
      if (success) onTap?.();
    });

  const gesture = Gesture.Exclusive(
    Gesture.Simultaneous(pinch, pan),
    doubleTap,
    singleTap,
  );

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityActions={[{ name: "magicTap" }]}
        accessibilityHint={t("Double-tap to zoom")}
        onAccessibilityAction={() => {
          if (current.scale > 1) settle(1, 0, 0, true);
          else settle(DOUBLE_TAP_SCALE, 0, 0, true);
        }}
        style={[
          styles.fill,
          { transform: [{ translateX }, { translateY }, { scale }] },
        ]}
      >
        <Image accessibilityRole="image" resizeMode="contain" source={{ uri }} style={styles.fill} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    height: "100%",
    width: "100%",
  },
});
