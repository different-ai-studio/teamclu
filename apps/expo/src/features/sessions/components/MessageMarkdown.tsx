import { memo, useMemo, type ComponentType } from "react";
import { processColor, View } from "react-native";
import Markdown, { type MarkdownProps } from "react-native-markdown-display";

import {
  nativeMarkdownView,
  type NativeMarkdownConfig,
  type NativeMarkdownViewProps,
} from "../../../../modules/teamclu-markdown/src";
import { splitMarkdownBlocks } from "./streaming-markdown-blocks";
import { MARKDOWN_BLOCK_GAP, type MarkdownPalette } from "./markdown-styles";
import { StreamingMarkdown } from "./StreamingMarkdown";

const configs = new WeakMap<MarkdownPalette, NativeMarkdownConfig>();

function colorInt(value: string): number {
  const processed = processColor(value);
  return typeof processed === "number" ? processed : 0;
}

function nativeConfig(palette: MarkdownPalette): NativeMarkdownConfig {
  let config = configs.get(palette);
  if (!config) {
    config = {
      textColor: colorInt(palette.text),
      linkColor: colorInt(palette.link),
      surfaceColor: colorInt(palette.surface),
      ruleColor: colorInt(palette.rule),
      fontSize: palette.base.fontSize,
      lineHeight: palette.base.lineHeight,
      blockGap: MARKDOWN_BLOCK_GAP,
    };
    configs.set(palette, config);
  }
  return config;
}

/**
 * A message body in markdown. On Android, where the row gives it a definite
 * width, it is one native TextView (Markwon): parsing a long reply and
 * building a view per paragraph, list item and span in JS took most of a
 * second on a low-end phone. Everywhere else — iOS, a bubble that sizes to its
 * text, a dev client without the module — the JS renderer draws it as before.
 */
export function MessageMarkdown({
  definiteWidth,
  palette,
  streaming = false,
  style,
  text,
}: {
  /** The parent has a fixed or stretched width; a native view has no intrinsic one. */
  definiteWidth: boolean;
  palette: MarkdownPalette;
  streaming?: boolean;
  /** The JS renderer's styles, built from the same palette. */
  style: MarkdownProps["style"];
  text: string;
}) {
  const NativeMarkdown = definiteWidth ? nativeMarkdownView() : null;
  if (NativeMarkdown && streaming) {
    return <NativeStreamingMarkdown config={nativeConfig(palette)} text={text} view={NativeMarkdown} />;
  }
  if (NativeMarkdown) {
    return (
      <NativeMarkdown
        config={nativeConfig(palette)}
        markdown={text}
        style={{ alignSelf: "stretch" }}
      />
    );
  }
  if (streaming) {
    return <StreamingMarkdown gap={MARKDOWN_BLOCK_GAP} style={style} text={text} />;
  }
  return <Markdown style={style}>{text}</Markdown>;
}

/**
 * A reply still being written, one native view per block (see
 * `splitMarkdownBlocks`). As a single view, every published chunk re-parsed
 * and re-laid out the whole reply on the UI thread; this way finished blocks
 * keep their text and only the last one is touched.
 */
function NativeStreamingMarkdown({
  config,
  text,
  view,
}: {
  config: NativeMarkdownConfig;
  text: string;
  view: ComponentType<NativeMarkdownViewProps>;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <View style={{ alignSelf: "stretch", gap: MARKDOWN_BLOCK_GAP }}>
      {blocks.map((block, index) => (
        <NativeBlock config={config} key={index} text={block} view={view} />
      ))}
    </View>
  );
}

const NativeBlock = memo(function NativeBlock({
  config,
  text,
  view: NativeMarkdown,
}: {
  config: NativeMarkdownConfig;
  text: string;
  view: ComponentType<NativeMarkdownViewProps>;
}) {
  return <NativeMarkdown config={config} markdown={text} style={{ alignSelf: "stretch" }} />;
});
