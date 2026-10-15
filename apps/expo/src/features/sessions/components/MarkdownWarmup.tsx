import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { nativeMarkdownView } from "../../../../modules/teamclu-markdown/src";
import { nativeConfig } from "./MessageMarkdown";
import { OTHER_PALETTE, OWN_PALETTE, TURN_PALETTE } from "./markdown-palettes";

const SAMPLE = [
  "## Warm-up",
  "Some **bold**, `code` and a [link](https://example.com).",
  "- one\n- two",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "```\nconst x = 1;\n```",
].join("\n\n");

const WARMUP_DELAY_MS = 600;
const WARMUP_HOLD_MS = 1500;

/**
 * Renders each palette's markdown once, off screen, shortly after launch. The
 * first session opened after a cold start paid for creating the Markwon
 * instances, loading the native view and table classes, on the tap — about
 * 0.8s before the screen transition could start. Android only, and only when
 * the native module is compiled in.
 */
export function MarkdownWarmup() {
  const NativeMarkdown = nativeMarkdownView();
  const [phase, setPhase] = useState<"waiting" | "rendering" | "done">("waiting");

  useEffect(() => {
    if (!NativeMarkdown) return;
    const start = setTimeout(() => setPhase("rendering"), WARMUP_DELAY_MS);
    const stop = setTimeout(() => setPhase("done"), WARMUP_DELAY_MS + WARMUP_HOLD_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(stop);
    };
  }, [NativeMarkdown]);

  if (!NativeMarkdown || phase !== "rendering") return null;
  return (
    <View pointerEvents="none" style={styles.offscreen}>
      {[TURN_PALETTE, OWN_PALETTE, OTHER_PALETTE].map((palette, index) => (
        <NativeMarkdown
          config={nativeConfig(palette)}
          key={index}
          markdown={SAMPLE}
          style={styles.block}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    alignSelf: "stretch",
  },
  offscreen: {
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
    width: 300,
  },
});
