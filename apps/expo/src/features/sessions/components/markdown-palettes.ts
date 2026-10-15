import { StyleSheet } from "react-native";

import { hai, iosType, typography } from "../../../ui/theme";
import type { MarkdownPalette } from "./markdown-styles";

/** The agent reply card's markdown (session feed). */
export const TURN_PALETTE: MarkdownPalette = {
  base: typography.body,
  hairline: StyleSheet.hairlineWidth,
  link: hai.cinnabar,
  rule: hai.hairline,
  surface: hai.pebble,
  text: hai.onyx,
};

/** The member's own bubble. */
export const OWN_PALETTE: MarkdownPalette = {
  base: iosType.subheadline,
  hairline: StyleSheet.hairlineWidth,
  link: hai.mist,
  rule: "rgba(248,246,241,0.35)",
  surface: "rgba(248,246,241,0.18)",
  text: hai.mist,
};

/** Everyone else's bubble, and the trace page's rows. */
export const OTHER_PALETTE: MarkdownPalette = {
  base: iosType.subheadline,
  hairline: StyleSheet.hairlineWidth,
  link: hai.cinnabar,
  rule: hai.hairline,
  surface: hai.pebble,
  text: hai.onyx,
};
