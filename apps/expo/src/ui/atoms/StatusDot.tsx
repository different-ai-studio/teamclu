import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, type ViewStyle } from "react-native";

import { colors, dotSize } from "../theme";

export type StatusDotKind = "active" | "idle" | "error" | "muted" | "working";

export type StatusDotProps = {
  kind?: StatusDotKind;
  size?: number;
  /** Overrides the kind's colour. iOS drives some dots straight off a token. */
  color?: string;
  /** Overrides whether the dot breathes. Defaults to `working` only. */
  breathing?: boolean;
  style?: ViewStyle;
};

const KIND_COLOR: Record<StatusDotKind, string> = {
  active: colors.sage,
  // iOS uses raw .yellow for an actively-streaming agent (AgentChipBar.swift).
  // Hai doesn't ship a yellow; use a warm amber that reads "in flight"
  // against Pebble/Mist surfaces without crashing into Cinnabar's
  // attention slot.
  working: "#C68A3A",
  idle: colors.slate,
  error: colors.cinnabarDeep,
  muted: colors.slate,
};

/** iOS `AMUXAnimation.breatheDuration` is 1.4s for a full cycle. */
const BREATHE_HALF_CYCLE_MS = 700;
/** iOS `BreathingOpacity` dims to 0.35 by default; DESIGN.md specs 0.45. */
const BREATHE_DIM = 0.45;

/**
 * 8px semantic status indicator. The breathing variant mirrors the iOS
 * `BreathingOpacity` modifier: a 1.4s ease-in-out cycle between 1 and 0.45,
 * and — like iOS — it stops entirely when the OS reports Reduce Motion.
 */
export function StatusDot({
  kind = "idle",
  size = dotSize.status,
  color,
  breathing,
  style,
}: StatusDotProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  // Only work in flight breathes by default, as on iOS. "active" used to as
  // well, and it marks every finished reply card, the live header and each
  // ready agent chip — a screen of idle loops that kept the render thread
  // drawing every frame long after the agent had stopped.
  const shouldBreathe = (breathing ?? kind === "working") && !reduceMotion;

  useEffect(() => {
    if (!shouldBreathe) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: BREATHE_DIM,
          duration: BREATHE_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: BREATHE_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, shouldBreathe]);

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color ?? KIND_COLOR[kind],
        },
        shouldBreathe ? { opacity } : null,
        style,
      ]}
    />
  );
}

export default StatusDot;
