import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { SheetModal } from "../../../ui/SheetModal";
import { colors, iosType, spacing, typography } from "../../../ui/theme";
import type { PendingInvite } from "../pending-invites";
import { InviteJoinSheet } from "./InviteJoinSheet";
import { APP_NAME, OnboardingErrorNote, OnboardingOptionRow } from "./OnboardingParts";

/**
 * Signed in, in no team, and the user said they are joining one — so nothing
 * was created for them. Most likely the invite hasn't arrived yet, or they
 * signed in with a different account than the one invited. Every way out is
 * here. Port of iOS `NoTeamView` (#1589).
 */
export function NoTeamScreen({
  email,
  errorMessage,
  isBusy,
  isRefreshing,
  pendingInvites,
  onAcceptInvite,
  onCreateInstead,
  onJoinWithToken,
  onRefresh,
  onSwitchAccount,
}: {
  email: string | null;
  errorMessage: string | null;
  isBusy: boolean;
  isRefreshing: boolean;
  pendingInvites: PendingInvite[];
  onAcceptInvite: (invite: PendingInvite) => void;
  /** → desktop guide (signed-in mode), whose continue creates the team. */
  onCreateInstead: () => void;
  onJoinWithToken: (token: string) => Promise<void>;
  onRefresh: () => void;
  onSwitchAccount: () => void;
}) {
  const { t } = useTranslation();
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("Not in a team yet")}</Text>
          <Text style={styles.subtitle}>
            {email
              ? t(
                  "{{email}} isn't in any team yet. Ask your team admin to invite this account, then refresh.",
                  { email },
                )
              : t(
                  "This account isn't in any team yet. Ask your team admin to invite it, then refresh.",
                )}
          </Text>
        </View>

        {pendingInvites.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.eyebrow}>{t("INVITES FOR YOU")}</Text>
            {pendingInvites.map((invite) => (
              <View key={invite.id} style={styles.inviteRow}>
                <View style={styles.inviteBody}>
                  <Text style={styles.inviteTitle}>{invite.teamName ?? t("A team")}</Text>
                  {invite.invitedByDisplayName ? (
                    <Text style={styles.inviteCaption}>
                      {t("Invited by {{name}}", { name: invite.invitedByDisplayName })}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  disabled={isBusy}
                  hitSlop={8}
                  onPress={() => onAcceptInvite(invite)}
                  testID={`noTeam.acceptInvite.${invite.id}`}
                >
                  <Text style={styles.joinLabel}>{t("Join")}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <OnboardingOptionRow
            caption={t("Check again after your admin sends the invite.")}
            disabled={isBusy || isRefreshing}
            icon="refresh"
            isPrimary
            onPress={onRefresh}
            testID="noTeam.refreshButton"
            title={isRefreshing ? t("Checking…") : t("Refresh")}
          />
          <OnboardingOptionRow
            caption={t("A teammate sent you a link.")}
            disabled={isBusy}
            icon="link-outline"
            onPress={() => setInviteOpen(true)}
            testID="noTeam.pasteInviteButton"
            title={t("Paste an invite link")}
          />
          <OnboardingOptionRow
            caption={t("The invite went to a different email or phone.")}
            disabled={isBusy}
            icon="person-circle-outline"
            onPress={onSwitchAccount}
            testID="noTeam.switchAccountButton"
            title={t("Use another account")}
          />
          <OnboardingOptionRow
            caption={t("Set up {{app}} for your own team.", { app: APP_NAME })}
            disabled={isBusy}
            icon="add-circle-outline"
            onPress={onCreateInstead}
            testID="noTeam.createButton"
            title={t("Start a new team instead")}
          />
        </View>

        {errorMessage && !inviteOpen ? <OnboardingErrorNote message={errorMessage} /> : null}
      </ScrollView>

      <SheetModal onRequestClose={() => setInviteOpen(false)} visible={inviteOpen}>
        <InviteJoinSheet
          errorMessage={errorMessage}
          isBusy={isBusy}
          mode="signedIn"
          onCancel={() => setInviteOpen(false)}
          onSubmit={async (token) => {
            try {
              await onJoinWithToken(token);
              setInviteOpen(false);
            } catch {
              // Stays open with the error inline so another link can be tried.
            }
          }}
        />
      </SheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
    paddingBottom: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
    paddingTop: 40,
  },
  eyebrow: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 10,
    letterSpacing: 2.5,
  },
  header: {
    gap: 10,
    paddingHorizontal: spacing.xs,
  },
  inviteBody: {
    flex: 1,
    gap: 3,
  },
  inviteCaption: {
    color: colors.basalt,
    ...iosType.caption,
  },
  inviteRow: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  inviteTitle: {
    color: colors.onyx,
    ...iosType.body,
    fontWeight: "600",
  },
  joinLabel: {
    color: colors.cinnabar,
    ...iosType.subheadline,
    fontWeight: "600",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.md,
  },
  subtitle: {
    color: colors.basalt,
    ...iosType.body,
  },
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 34,
    lineHeight: 40,
  },
});
