import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
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
import { TeamAppStatusDot } from "../../src/features/apps/components/TeamAppStatusDot";
import {
  TEAM_APP_FILTERS,
  filterTeamApps,
  teamAppFilterLabelKey,
  teamAppStatusKind,
  teamAppStatusLabelKey,
  teamAppTypeIcon,
  teamAppTypeLabelKey,
  type TeamApp,
  type TeamAppFilter,
} from "../../src/features/apps/team-app-types";
import { createConfiguredTeamAppsApi } from "../../src/features/apps/team-apps-api";
import { rememberTeamApps } from "../../src/features/apps/team-apps-memory";
import { supabase } from "../../src/lib/supabase/client";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

/**
 * Team apps list, opened from the shortcuts drawer. Port of iOS
 * `TeamAppsView`: filter chips, a status dot per row, and an empty state that
 * asks for the first app rather than shrugging.
 */
export default function TeamAppsRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [apps, setApps] = useState<TeamApp[]>([]);
  // True once a load has finished, however it went: the empty-state pitch
  // must not flash before the first answer.
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TeamAppFilter>("all");
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (!teamId || inFlight.current) {
      if (!teamId) setHasLoaded(true);
      return;
    }
    inFlight.current = true;
    try {
      const rows = await createConfiguredTeamAppsApi(supabase).listApps(teamId);
      rememberTeamApps(rows);
      setApps(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't load apps."));
    } finally {
      inFlight.current = false;
      setHasLoaded(true);
    }
  }, [teamId, t]);

  // Reload on every focus, so an app created from the new-app screen shows up
  // when that screen closes.
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  const openNewApp = () => router.push("/(app)/new-team-app");
  const visibleApps = filterTeamApps(apps, filter);

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Team apps")}</Text>
        <View style={styles.headerSlotGroup}>
          <Pressable
            accessibilityLabel={t("New app")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={openNewApp}
            style={styles.headerSlot}
          >
            <Ionicons color={colors.cinnabar} name="add" size={26} />
          </Pressable>
          <Pressable
            accessibilityLabel={t("Close")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.back()}
            style={styles.headerSlot}
          >
            <Ionicons color={colors.onyx} name="close" size={26} />
          </Pressable>
        </View>
      </GlassHeader>

      {!hasLoaded && apps.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.basalt} />
        </View>
      ) : apps.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContent}
          refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} />}
        >
          <Ionicons color={colors.slate} name="grid-outline" size={34} />
          <View style={styles.emptyText}>
            <Text style={styles.emptyTitle}>{t("No team apps yet")}</Text>
            <Text style={styles.emptyBody}>
              {t(
                "Apps are small tools or pages your team uses together. Once built, you can share them with teammates and let agents maintain them.",
              )}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={openNewApp}
            style={({ pressed }) => [styles.cta, pressed ? styles.ctaPressed : null]}
          >
            <Text style={styles.ctaText}>{t("Create your first app")}</Text>
          </Pressable>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} />}
        >
          <ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {TEAM_APP_FILTERS.map((value) => {
              const selected = filter === value;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={value}
                  onPress={() => setFilter(value)}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                    {t(teamAppFilterLabelKey(value))}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {visibleApps.length > 0 ? (
            <View style={styles.card}>
              {visibleApps.map((app, index) => (
                <View key={app.id}>
                  <TeamAppRow
                    app={app}
                    onPress={() =>
                      router.push({
                        pathname: "/(app)/team-app-detail",
                        params: { appId: app.id },
                      })
                    }
                  />
                  {index < visibleApps.length - 1 ? <Hairline style={styles.rowDivider} /> : null}
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.muted}>{t("No apps under this filter yet.")}</Text>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

function TeamAppRow({ app, onPress }: { app: TeamApp; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={styles.iconTile}>
        <Ionicons
          color={colors.basalt}
          name={teamAppTypeIcon(app.type) as React.ComponentProps<typeof Ionicons>["name"]}
          size={18}
        />
      </View>
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {app.name || app.slug}
        </Text>
        <View style={styles.rowMetaLine}>
          <TeamAppStatusDot kind={teamAppStatusKind(app)} />
          <Text numberOfLines={1} style={styles.rowMeta}>
            {t(teamAppStatusLabelKey(app))} · {t(teamAppTypeLabelKey(app.type))}
          </Text>
        </View>
      </View>
      <Ionicons color={colors.slate} name="chevron-forward" size={16} />
    </Pressable>
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
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  chip: {
    backgroundColor: "rgba(226,223,217,0.4)",
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipSelected: {
    backgroundColor: hai.pebble,
  },
  chipText: {
    color: colors.basalt,
    ...typography.caption,
  },
  chipTextSelected: {
    color: colors.onyx,
  },
  chips: {
    gap: spacing.sm,
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  cta: {
    alignItems: "center",
    alignSelf: "stretch",
    backgroundColor: hai.cinnabar,
    borderRadius: radii.button,
    paddingVertical: 13,
  },
  ctaPressed: {
    opacity: 0.88,
  },
  ctaText: {
    color: hai.paper,
    ...typography.cardTitle,
  },
  emptyBody: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  emptyContent: {
    alignItems: "center",
    flexGrow: 1,
    gap: 18,
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT,
  },
  emptyText: {
    alignItems: "center",
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    textAlign: "center",
    ...typography.caption,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerSlotGroup: {
    flexDirection: "row",
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  iconTile: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  muted: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowDivider: {
    marginLeft: 60,
  },
  rowMeta: {
    color: colors.slate,
    flexShrink: 1,
    ...typography.caption,
  },
  rowMetaLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  rowTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
});
