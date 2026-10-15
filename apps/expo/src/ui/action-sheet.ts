import { ActionSheetIOS, Alert, Platform } from "react-native";

import { presentActionSheet } from "./ActionSheetHost";

export type SheetAction = {
  label: string;
  style?: "default" | "destructive";
  /** The current choice of a picker (iOS `Picker` in a `Menu` checks it). */
  checked?: boolean;
  run: () => void;
};

/**
 * An action list: the native action sheet on iOS, `ActionSheetHost` on
 * Android. The cancel entry is added here. The alert is only a fallback for
 * when no host is mounted — it shows at most three buttons on Android.
 */
export function showActionSheet(
  actions: readonly SheetAction[],
  options: { cancelLabel: string; title?: string },
): void {
  if (actions.length === 0) return;
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: options.title,
        // The native sheet has no check mark; mark the current choice in text.
        options: [...actions.map((a) => (a.checked ? `✓ ${a.label}` : a.label)), options.cancelLabel],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.style === "destructive"),
      },
      (index) => actions[index]?.run(),
    );
    return;
  }
  if (presentActionSheet({ actions, cancelLabel: options.cancelLabel, title: options.title })) {
    return;
  }
  Alert.alert(options.title ?? "", undefined, [
    ...actions.map((a) => ({
      text: a.label,
      style: a.style === "destructive" ? ("destructive" as const) : ("default" as const),
      onPress: a.run,
    })),
    { text: options.cancelLabel, style: "cancel" as const },
  ]);
}
