import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { SheetAction } from "./action-sheet";
import { colors, hai, radii, spacing, typography } from "./theme";

export type ActionSheetRequest = {
  actions: readonly SheetAction[];
  cancelLabel: string;
  title?: string;
};

type Presenter = (request: ActionSheetRequest) => void;

let presenter: Presenter | null = null;

/** Shows `request` in the mounted host; false when there is none. */
export function presentActionSheet(request: ActionSheetRequest): boolean {
  if (!presenter) return false;
  presenter(request);
  return true;
}

/**
 * Android's action list. `Alert` was standing in for it, and an Android alert
 * holds at most three buttons: a message's long-press menu (copy, reply, ask
 * again, select, cancel) silently lost "Select" and "Cancel", and the session
 * list's seven actions showed three. Mount once near the root; iOS keeps the
 * native action sheet.
 */
export function ActionSheetHost() {
  const insets = useSafeAreaInsets();
  const [request, setRequest] = useState<ActionSheetRequest | null>(null);

  useEffect(() => {
    presenter = setRequest;
    return () => {
      if (presenter === setRequest) presenter = null;
    };
  }, []);

  const close = () => setRequest(null);
  const choose = (action: SheetAction) => {
    setRequest(null);
    // After the sheet is gone, so an action that opens its own UI (a prompt,
    // another sheet) is not presented under this one.
    setTimeout(action.run, 0);
  };

  return (
    <Modal
      animationType="fade"
      navigationBarTranslucent
      onRequestClose={close}
      statusBarTranslucent
      transparent
      visible={request !== null}
    >
      <Pressable accessibilityLabel={request?.cancelLabel} onPress={close} style={styles.backdrop} />
      {request ? (
        <View style={[styles.panel, { paddingBottom: insets.bottom + spacing.sm }]}>
          {request.title ? <Text style={styles.title}>{request.title}</Text> : null}
          <ScrollView bounces={false} style={styles.list}>
            {request.actions.map((action, index) => (
              <Pressable
                accessibilityRole="button"
                key={`${index}:${action.label}`}
                onPress={() => choose(action)}
                style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
              >
                <Text
                  style={[styles.label, action.style === "destructive" ? styles.destructive : null]}
                >
                  {action.label}
                </Text>
                {action.checked ? <Ionicons color={colors.onyx} name="checkmark" size={18} /> : null}
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            onPress={close}
            style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          >
            <Text style={[styles.label, styles.cancel]}>{request.cancelLabel}</Text>
          </Pressable>
        </View>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(34,32,29,0.32)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  cancel: {
    color: colors.slate,
  },
  destructive: {
    color: hai.cinnabarDeep,
  },
  divider: {
    backgroundColor: colors.hairline,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.lg,
  },
  label: {
    color: colors.onyx,
    ...typography.body,
    fontSize: 16,
  },
  list: {
    maxHeight: 420,
  },
  panel: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: radii.card * 2,
    borderTopRightRadius: radii.card * 2,
    bottom: 0,
    left: 0,
    paddingTop: spacing.sm,
    position: "absolute",
    right: 0,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
    paddingHorizontal: spacing.xl,
  },
  rowPressed: {
    backgroundColor: hai.pebble,
  },
  title: {
    color: colors.slate,
    ...typography.caption,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
});
