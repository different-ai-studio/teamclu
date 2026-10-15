import { memo, useMemo } from "react";
import { View } from "react-native";
import Markdown, { type MarkdownProps } from "react-native-markdown-display";

import { splitMarkdownBlocks } from "./streaming-markdown-blocks";

type MarkdownStyle = MarkdownProps["style"];

/** One finished block: same text and style, no render. */
const MarkdownBlock = memo(function MarkdownBlock({
  style,
  text,
}: {
  style: MarkdownStyle;
  text: string;
}) {
  return <Markdown style={style}>{text}</Markdown>;
});

/**
 * Markdown for text that is still being written; see `splitMarkdownBlocks`.
 * Blocks are keyed by position, which is stable because text only grows.
 */
export function StreamingMarkdown({
  gap,
  style,
  text,
}: {
  /** The spacing the single-document body puts between blocks. */
  gap: number;
  style: MarkdownStyle;
  text: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <View style={{ gap }}>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} style={style} text={block} />
      ))}
    </View>
  );
}
