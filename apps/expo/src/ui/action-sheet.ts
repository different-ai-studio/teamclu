import { ActionSheetIOS, Alert, Platform } from "react-native";

export type SheetAction = {
  label: string;
  style?: "default" | "destructive";
  run: () => void;
};

/**
 * A native action list: the iOS action sheet, an alert on Android. The
 * cancel entry is added here.
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
        options: [...actions.map((a) => a.label), options.cancelLabel],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.style === "destructive"),
      },
      (index) => actions[index]?.run(),
    );
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
