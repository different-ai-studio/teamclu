import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { SheetModal } from "../../../ui/SheetModal";
import { colors, iosType, spacing, typography } from "../../../ui/theme";
import { InviteJoinSheet } from "./InviteJoinSheet";
import { APP_NAME, OnboardingErrorNote, OnboardingOptionRow } from "./OnboardingParts";
import { ServerSettingsSheet } from "./ServerSettingsSheet";

export type OnboardingChoiceScreenProps = {
  errorMessage?: string | null;
  isBusy?: boolean;
  /** "Join my team" → sign in. The caller records the `join` intent. */
  onJoin: () => void;
  /** "Start a new team" → desktop guide. The caller records `create`. */
  onCreate: () => void;
  /** A pasted invite: stash it and sign in; the claim runs afterwards. */
  onInviteToken: (token: string) => void | Promise<void>;
  /** Rebuild the Cloud API stack after a custom-server save (mirrors iOS). */
  onServerChanged?: () => void | Promise<void>;
};

/**
 * Pre-login fork: is this person joining a team that already uses the app, or
 * starting one? Port of iOS `OnboardingChoiceView` (#1589). The answer decides
 * what happens after sign-in when the account has no team.
 */
export function OnboardingChoiceScreen({
  errorMessage,
  isBusy = false,
  onJoin,
  onCreate,
  onInviteToken,
  onServerChanged,
}: OnboardingChoiceScreenProps) {
  const { t } = useTranslation();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityLabel={t("Server settings")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setServerOpen(true)}
          style={({ pressed }) => [styles.toolbarButton, pressed ? styles.pressed : null]}
          testID="welcome.serverSettingsButton"
        >
          <Ionicons color={colors.slate} name="globe-outline" size={22} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("How are you starting?")}</Text>
          <Text style={styles.subtitle}>
            {t("{{app}} works best when your whole team is on it.", { app: APP_NAME })}
          </Text>
        </View>

        <View style={styles.options}>
          <OnboardingOptionRow
            caption={t("My team already uses {{app}}.", { app: APP_NAME })}
            disabled={isBusy}
            icon="people-outline"
            isPrimary
            onPress={onJoin}
            testID="onboarding.joinButton"
            title={t("Join my team")}
          />
          <OnboardingOptionRow
            caption={t("Set up {{app}} for my team.", { app: APP_NAME })}
            disabled={isBusy}
            icon="add-circle-outline"
            onPress={onCreate}
            testID="onboarding.createButton"
            title={t("Start a new team")}
          />

          <View style={styles.inviteBlock}>
            <Pressable
              accessibilityRole="button"
              disabled={isBusy}
              hitSlop={6}
              onPress={() => setInviteOpen(true)}
              testID="onboarding.inviteLinkButton"
            >
              <Text style={styles.inviteLink}>{t("Have an invite link?")}</Text>
            </Pressable>
            <Text style={styles.inviteHint}>
              {t("No invite yet? Ask your team admin to invite you.")}
            </Text>
          </View>
        </View>

        {errorMessage ? <OnboardingErrorNote message={errorMessage} /> : null}
      </ScrollView>

      <SheetModal onRequestClose={() => setInviteOpen(false)} visible={inviteOpen}>
        <InviteJoinSheet
          errorMessage={null}
          isBusy={isBusy}
          mode="signedOut"
          onCancel={() => setInviteOpen(false)}
          onSubmit={async (token) => {
            setInviteOpen(false);
            await onInviteToken(token);
          }}
        />
      </SheetModal>

      <SheetModal
        onRequestClose={() => {
          if (!isBusy) setServerOpen(false);
        }}
        visible={serverOpen}
      >
        <ServerSettingsSheet
          onCancel={() => setServerOpen(false)}
          onSaved={async () => {
            setServerOpen(false);
            await onServerChanged?.();
          }}
        />
      </SheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: spacing.xxl,
    justifyContent: "center",
    paddingBottom: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
  },
  header: {
    gap: 10,
    paddingHorizontal: spacing.xs,
  },
  inviteBlock: {
    gap: 6,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.sm,
  },
  inviteHint: {
    color: colors.slate,
    ...iosType.footnote,
  },
  inviteLink: {
    color: colors.cinnabar,
    ...iosType.subheadline,
    fontWeight: "500",
  },
  options: {
    gap: spacing.md,
  },
  pressed: {
    opacity: 0.6,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  subtitle: {
    color: colors.basalt,
    ...iosType.body,
  },
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 34,
    fontWeight: "400",
    lineHeight: 40,
  },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  toolbarButton: {
    padding: spacing.sm,
  },
});
