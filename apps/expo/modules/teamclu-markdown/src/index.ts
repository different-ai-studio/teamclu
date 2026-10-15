import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import { Platform, type ViewProps } from "react-native";

export type NativeMarkdownConfig = {
  textColor: number;
  linkColor: number;
  surfaceColor: number;
  ruleColor: number;
  fontSize: number;
  lineHeight: number;
  blockGap: number;
};

export type NativeMarkdownViewProps = ViewProps & {
  markdown: string;
  config: NativeMarkdownConfig;
};

let resolved: ComponentType<NativeMarkdownViewProps> | null | undefined;

/**
 * The native markdown view (Android, Markwon), or null where it does not
 * exist — iOS, tests, or a dev client built before the module was added.
 */
export function nativeMarkdownView(): ComponentType<NativeMarkdownViewProps> | null {
  if (resolved !== undefined) return resolved;
  if (Platform.OS !== "android") {
    resolved = null;
    return resolved;
  }
  // `requireNativeView` does not fail for a view that is not compiled in — it
  // warns and the first render crashes — so ask for the module first.
  resolved = requireOptionalNativeModule("TeamcluMarkdown")
    ? requireNativeView<NativeMarkdownViewProps>("TeamcluMarkdown")
    : null;
  return resolved;
}
