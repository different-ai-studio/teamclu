import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { parseInviteInput } from "../invite-api";

/**
 * Paste a `teamclu://invite?token=…` link (or a bare token). iOS
 * `InviteJoinSheet`.
 *
 *  - `signedOut` (the choice screen): the token is stashed and the user signs
 *    in; the claim runs as that account once signed in.
 *  - `signedIn` (the no-team screen): claims as the current account.
 */
export function InviteJoinSheet({
  errorMessage,
  isBusy,
  mode,
  onCancel,
  onSubmit,
}: {
  errorMessage: string | null;
  isBusy: boolean;
  mode: "signedOut" | "signedIn";
  onCancel: () => void;
  onSubmit: (token: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const visibleError = localError ?? errorMessage;
  const empty = raw.trim().length === 0;

  const submit = () => {
    if (empty) {
      setLocalError(t("Paste an invite link or token first."));
      return;
    }
    const token = parseInviteInput(raw);
    if (!token) {
      setLocalError(t("Couldn't read a token from that link."));
      return;
    }
    setLocalError(null);
    void Promise.resolve(onSubmit(token)).catch(() => {
      // The caller surfaces the failure through `errorMessage`.
    });
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("Join with invite link")}</Text>
        <Pressable
          accessibilityLabel={t("Cancel")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onCancel}
        >
          <Ionicons color={colors.onyx} name="close" size={24} />
        </Pressable>
      </View>
      <Hairline />
      <View style={styles.body}>
        <Text style={styles.caption}>
          {mode === "signedIn"
            ? t("Paste the link your teammate shared to join their team with this account.")
            : t(
                "Paste the link your teammate shared. TeamClu will sign you in and add you to their team.",
              )}
        </Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isBusy}
          multiline
          numberOfLines={3}
          onChangeText={(value) => {
            setRaw(value);
            if (localError) setLocalError(null);
          }}
          placeholder={t("teamclu://invite?token=… or just the token")}
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.input}
          testID="invite.tokenField"
          value={raw}
        />
        {visibleError ? (
          <View style={styles.errorBanner}>
            <Ionicons color={colors.cinnabar} name="warning" size={16} />
            <Text style={styles.errorText}>{visibleError}</Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={isBusy || empty}
          onPress={submit}
          style={({ pressed }) => [
            styles.submit,
            isBusy || empty ? styles.submitDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          testID="invite.continueButton"
        >
          <Text style={styles.submitLabel}>
            {isBusy ? t("Joining…") : t("Continue")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.md,
    padding: spacing.xl,
  },
  caption: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  errorBanner: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.card,
    flexDirection: "row",
    gap: 6,
    padding: spacing.sm,
  },
  errorText: {
    color: colors.onyx,
    flex: 1,
    ...typography.caption,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  input: {
    backgroundColor: colors.pebble,
    borderRadius: radii.card,
    color: colors.onyx,
    minHeight: 80,
    padding: spacing.md,
    textAlignVertical: "top",
    ...typography.body,
  },
  pressed: {
    opacity: 0.85,
  },
  sheet: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  submit: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  submitDisabled: {
    opacity: 0.45,
  },
  submitLabel: {
    color: colors.paper,
    ...typography.cardTitle,
  },
  title: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
});
