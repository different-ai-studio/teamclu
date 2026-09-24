import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import {
  createConfiguredInviteApi,
  type PendingInvite,
} from "../../src/features/onboarding/invite-api";
import { supabase } from "../../src/lib/supabase/client";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";
import { showToast } from "../../src/ui/Toast";

/**
 * Invites addressed to the signed-in user's verified email/phone — iOS
 * `PendingInvitesSheet`, opened from Settings → Team. Joining lands on the
 * joined team (the whole shell is replaced, as a team switch does); declining
 * removes the row in place.
 */
export default function PendingInvitesRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { controller } = useOnboarding();
  const inviteApi = useMemo(() => createConfiguredInviteApi(supabase), []);

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setInvites(await inviteApi.listPending());
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("Couldn't load invites."));
    } finally {
      setIsLoading(false);
    }
  }, [inviteApi, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const decline = (invite: PendingInvite) => {
    if (busyInviteId) return;
    setBusyInviteId(invite.inviteId);
    void inviteApi
      .declinePending(invite.inviteId)
      .then(() => {
        setInvites((prev) => prev.filter((row) => row.inviteId !== invite.inviteId));
      })
      .catch((err: unknown) => {
        showToast("error", err instanceof Error ? err.message : t("Couldn't decline the invite."));
      })
      .finally(() => setBusyInviteId(null));
  };

  const join = (invite: PendingInvite) => {
    if (busyInviteId) return;
    setBusyInviteId(invite.inviteId);
    void (async () => {
      try {
        const result = await inviteApi.acceptPending(invite.inviteId);
        await controller.joinedTeam(result.teamId, result.refreshToken);
        router.replace("/");
      } catch (err) {
        setBusyInviteId(null);
        showToast("error", err instanceof Error ? err.message : t("Couldn't join the team."));
      }
    })();
  };

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Pending Invites")}</Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.back()}
          style={styles.headerSlot}
        >
          <Text style={styles.headerAction}>{t("Done")}</Text>
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => void load()}
            refreshing={isLoading && invites.length > 0}
            tintColor={colors.slate}
          />
        }
      >
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

        {isLoading && invites.length === 0 ? (
          <View style={styles.stateRow}>
            <ActivityIndicator color={colors.slate} />
          </View>
        ) : invites.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Ionicons color={colors.slate} name="mail-open-outline" size={32} />
            <Text style={styles.emptyTitle}>{t("No Pending Invites")}</Text>
            <Text style={styles.emptyBody}>
              {t("Invites sent to your email or phone show up here.")}
            </Text>
          </View>
        ) : (
          invites.map((invite) => {
            const isBusy = busyInviteId === invite.inviteId;
            return (
              <View key={invite.inviteId} style={styles.card}>
                <View style={styles.cardBody}>
                  <Text numberOfLines={1} style={styles.teamName}>
                    {invite.teamName ?? t("Unnamed team")}
                  </Text>
                  {invite.invitedByDisplayName ? (
                    <Text style={styles.meta}>
                      {t("Invited by {{value}}", { value: invite.invitedByDisplayName })}
                    </Text>
                  ) : null}
                  {invite.teamRole ? (
                    <Text style={styles.meta}>
                      {t("Role: {{value}}", { value: invite.teamRole })}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyInviteId !== null}
                    onPress={() => decline(invite)}
                    style={({ pressed }) => [
                      styles.actionButton,
                      styles.declineButton,
                      busyInviteId !== null ? styles.actionDisabled : null,
                      pressed ? styles.actionPressed : null,
                    ]}
                  >
                    <Text style={[styles.actionText, styles.declineText]}>{t("Decline")}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyInviteId !== null}
                    onPress={() => join(invite)}
                    style={({ pressed }) => [
                      styles.actionButton,
                      styles.joinButton,
                      busyInviteId !== null && !isBusy ? styles.actionDisabled : null,
                      pressed ? styles.actionPressed : null,
                    ]}
                  >
                    {isBusy ? (
                      <ActivityIndicator color={hai.sage} size="small" />
                    ) : (
                      <Text style={[styles.actionText, styles.joinText]}>{t("Join")}</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: "center",
    borderRadius: 999,
    flex: 1,
    justifyContent: "center",
    minHeight: 36,
    paddingVertical: spacing.sm,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionPressed: {
    opacity: 0.7,
  },
  actionText: {
    ...typography.secondaryBody,
    fontWeight: "600",
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  cardBody: {
    gap: 2,
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  declineButton: {
    backgroundColor: "rgba(140,52,38,0.10)",
  },
  declineText: {
    color: hai.cinnabarDeep,
  },
  emptyBlock: {
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxl,
  },
  emptyBody: {
    color: colors.slate,
    textAlign: "center",
    ...typography.caption,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  headerAction: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 56,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  joinButton: {
    backgroundColor: "rgba(126,140,114,0.18)",
  },
  joinText: {
    color: hai.sage,
  },
  meta: {
    color: colors.slate,
    ...typography.caption,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  stateRow: {
    paddingVertical: spacing.lg,
  },
  teamName: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});
