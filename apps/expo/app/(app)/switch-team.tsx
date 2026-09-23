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
import { groupMembershipsByOrg } from "../../src/features/teams/membership-groups";
import { createTeamsApi, type TeamMembership } from "../../src/features/teams/teams-api";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";
import { colors, hai, iosType, radii, spacing, typography } from "../../src/ui/theme";

/**
 * Settings → Switch Team: the org → team picker, reached after login. iOS
 * `beginTeamSwitch` routes to the same `OrgTeamPickerView` the login uses, with
 * a Cancel that drops back to the still-live current team.
 *
 * Grouped by org because the org decides whether a team works at all — the
 * session is active in one org, and picking a team in another re-mints it.
 *
 * On success the whole app shell is replaced (`router.replace("/")`), the same
 * way sign-out leaves it: every screen underneath was built for the previous
 * team, including any session detail pushed inside a tab, and remounting from
 * the root is the only reset that reaches all of them.
 */
export default function SwitchTeamRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { state, controller } = useOnboarding();
  const currentTeamId = state.currentTeam?.id ?? null;

  const [memberships, setMemberships] = useState<TeamMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null);

  const teamsApi = useMemo(
    () => createTeamsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { memberships: rows } = await teamsApi.listMemberships();
      setMemberships(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("Couldn't load teams."));
    } finally {
      setIsLoading(false);
    }
  }, [teamsApi, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (teamId: string) => {
    if (busyTeamId) return;
    if (teamId === currentTeamId) {
      router.back();
      return;
    }
    setBusyTeamId(teamId);
    setSwitchError(null);
    void controller
      .switchTeam(teamId)
      .then(() => {
        router.replace("/");
      })
      .catch((err: unknown) => {
        setBusyTeamId(null);
        setSwitchError(err instanceof Error ? err.message : t("Couldn't switch team."));
      });
  };

  const groups = groupMembershipsByOrg(memberships);

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <Pressable
          accessibilityRole="button"
          disabled={busyTeamId !== null}
          hitSlop={8}
          onPress={() => router.back()}
          style={styles.headerSlot}
        >
          <Text style={styles.headerAction}>{t("Cancel")}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t("Choose a team")}</Text>
        <View style={styles.headerSlot} />
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => void load()}
            refreshing={isLoading && memberships.length > 0}
            tintColor={colors.slate}
          />
        }
      >
        {switchError ? <Text style={styles.errorText}>{switchError}</Text> : null}

        {isLoading && memberships.length === 0 ? (
          <View style={styles.stateRow}>
            <ActivityIndicator color={colors.slate} />
          </View>
        ) : loadError ? (
          <Text style={styles.errorText}>{loadError}</Text>
        ) : (
          groups.map((group) => (
            <View key={group.org} style={styles.section}>
              <SectionEyebrow
                label={`${group.org.toUpperCase()} · ${group.memberships.length}`}
                style={styles.sectionEyebrow}
              />
              <View style={styles.card}>
                {group.memberships.map((team, index) => {
                  const isCurrent = team.teamId === currentTeamId;
                  return (
                    <View key={team.teamId}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{
                          disabled: busyTeamId !== null,
                          selected: isCurrent,
                        }}
                        disabled={busyTeamId !== null}
                        onPress={() => pick(team.teamId)}
                        style={({ pressed }) => [
                          styles.row,
                          pressed && busyTeamId === null ? styles.rowPressed : null,
                        ]}
                      >
                        <View style={styles.rowBody}>
                          <Text numberOfLines={1} style={styles.rowLabel}>
                            {team.name}
                          </Text>
                          <Text numberOfLines={1} style={styles.rowMeta}>
                            {isCurrent
                              ? `${t("Current team")} · ${team.role}`
                              : `${team.slug || team.teamId.slice(0, 8)} · ${team.role}`}
                          </Text>
                        </View>
                        {busyTeamId === team.teamId ? (
                          <ActivityIndicator color={colors.slate} size="small" />
                        ) : isCurrent ? (
                          <Ionicons color={hai.cinnabar} name="checkmark" size={18} />
                        ) : (
                          <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                        )}
                      </Pressable>
                      {index < group.memberships.length - 1 ? <Hairline /> : null}
                    </View>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...iosType.footnote,
  },
  headerAction: {
    color: colors.onyx,
    ...typography.body,
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
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...iosType.body,
  },
  rowMeta: {
    color: colors.slate,
    ...iosType.caption,
  },
  rowPressed: {
    backgroundColor: colors.mist,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
  },
  stateRow: {
    paddingVertical: spacing.lg,
  },
});
