import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
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

import { TeamAppStatusDot } from "../../src/features/apps/components/TeamAppStatusDot";
import {
  teamAppNeedsDesktopSetup,
  teamAppOpenableUrl,
  teamAppRelationshipLabelKey,
  teamAppSessionTitle,
  teamAppSourceLabelKey,
  teamAppStatusKind,
  teamAppStatusLabelKey,
  teamAppTypeIcon,
  teamAppTypeLabelKey,
  teamAppVisibilityLabelKey,
  type TeamApp,
  type TeamAppSession,
} from "../../src/features/apps/team-app-types";
import {
  TeamAppNotFoundError,
  createConfiguredTeamAppsApi,
} from "../../src/features/apps/team-apps-api";
import { recallTeamApp, rememberTeamApps } from "../../src/features/apps/team-apps-memory";
import { supabase } from "../../src/lib/supabase/client";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

function formatDateTime(iso: string, withTime: boolean): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
}

/**
 * One app, read-only. Port of iOS `TeamAppDetailView`: everything this client
 * could change about an app lives on a desktop, so the page answers "is it
 * up, and where" and then gets out of the way.
 */
export default function TeamAppDetailRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ appId?: string }>();
  const appId = typeof params.appId === "string" ? params.appId : "";

  const [app, setApp] = useState<TeamApp | null>(() => (appId ? recallTeamApp(appId) : null));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<TeamAppSession[]>([]);
  const [loadedSessions, setLoadedSessions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!appId) return;
    const api = createConfiguredTeamAppsApi(supabase);
    // Deploy state is exactly the thing that has moved on since the list was
    // fetched, so re-read the app even when one was handed over.
    try {
      const fresh = await api.getApp(appId);
      rememberTeamApps([fresh]);
      setApp(fresh);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof TeamAppNotFoundError
          ? t("This app can't be opened. It may have been deleted, or you don't have access.")
          : err instanceof Error
            ? err.message
            : t("Couldn't load the app."),
      );
    }
    // A failure leaves the section empty rather than raising an error over
    // the whole page: the sessions list is context here, not the subject.
    try {
      setSessions(await api.listAppSessions(appId));
    } catch {
      setSessions([]);
    } finally {
      setLoadedSessions(true);
    }
  }, [appId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(app)/(tabs)/sessions");
  };

  const openSession = (sessionId: string) => {
    // The apps pages are stacked modals over the tabs; clear them so the
    // session opens in the sessions stack rather than under a sheet.
    if (router.canDismiss()) router.dismissAll();
    router.push(`/(app)/sessions/${sessionId}`);
  };

  const url = app ? teamAppOpenableUrl(app) : null;

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text numberOfLines={1} style={styles.headerTitle}>
          {app?.name || t("Team app")}
        </Text>
        <Pressable
          accessibilityLabel={t("Close")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={close}
          style={styles.headerSlot}
        >
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      {!app ? (
        <View style={styles.centered}>
          {loadError ? (
            <Text style={styles.stateText}>{loadError}</Text>
          ) : (
            <ActivityIndicator color={colors.basalt} />
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} />}
        >
          <View style={styles.header}>
            <Ionicons
              color={colors.basalt}
              name={teamAppTypeIcon(app.type) as React.ComponentProps<typeof Ionicons>["name"]}
              size={24}
            />
            <View style={styles.headerBody}>
              <Text style={styles.appName}>{app.name || app.slug}</Text>
              <View style={styles.statusLine}>
                <TeamAppStatusDot kind={teamAppStatusKind(app)} />
                <Text style={styles.statusText}>{t(teamAppStatusLabelKey(app))}</Text>
              </View>
            </View>
          </View>

          {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

          {teamAppNeedsDesktopSetup(app) ? (
            <View style={styles.hint}>
              <Text style={styles.hintTitle}>{t("Not initialized yet")}</Text>
              <Text style={styles.hintBody}>
                {t(
                  "This app is only a record so far; its code is written on a computer. Open TeamClu on your computer, select it in the app library, and finish setup and deployment there.",
                )}
              </Text>
            </View>
          ) : null}

          {url ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => void WebBrowser.openBrowserAsync(url)}
              style={({ pressed }) => [styles.openCard, pressed ? styles.pressed : null]}
            >
              <Ionicons color={colors.cinnabar} name="open-outline" size={18} />
              <View style={styles.openBody}>
                <Text style={styles.openTitle}>{t("Open app")}</Text>
                <Text ellipsizeMode="middle" numberOfLines={1} style={styles.openUrl}>
                  {url}
                </Text>
              </View>
            </Pressable>
          ) : null}

          <View style={styles.section}>
            <SectionEyebrow label={t("DETAILS")} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              <DetailRow label={t("Type")} value={t(teamAppTypeLabelKey(app.type))} />
              <Hairline style={styles.divider} />
              <DetailRow
                label={t("Visibility")}
                value={t(teamAppVisibilityLabelKey(app.visibility))}
              />
              <Hairline style={styles.divider} />
              <DetailRow label={t("Code source")} value={t(teamAppSourceLabelKey(app))} />
              <Hairline style={styles.divider} />
              <DetailRow
                label={t("My relationship")}
                value={t(teamAppRelationshipLabelKey(app.relationship))}
              />
              <Hairline style={styles.divider} />
              <DetailRow
                label={t("Created")}
                muted
                value={formatDateTime(app.createdAt, true)}
              />
            </View>
          </View>

          <View style={styles.section}>
            <SectionEyebrow label={t("RELATED SESSIONS")} style={styles.sectionEyebrow} />
            {sessions.length === 0 ? (
              <Text style={styles.muted}>
                {loadedSessions ? t("No sessions are linked to this app yet.") : t("Loading…")}
              </Text>
            ) : (
              <View style={styles.card}>
                {sessions.map((session, index) => {
                  const title = teamAppSessionTitle(session);
                  return (
                    <View key={session.id}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => openSession(session.id)}
                        style={({ pressed }) => [pressed ? styles.pressed : null]}
                      >
                        <DetailRow
                          chevron
                          label={title.isPlaceholder ? t(title.text) : title.text}
                          muted
                          value={formatDateTime(session.lastMessageAt ?? session.updatedAt, false)}
                        />
                      </Pressable>
                      {index < sessions.length - 1 ? <Hairline style={styles.divider} /> : null}
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function DetailRow({
  chevron = false,
  label,
  muted = false,
  value,
}: {
  chevron?: boolean;
  label: string;
  muted?: boolean;
  value: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Text numberOfLines={1} style={styles.detailLabel}>
        {label}
      </Text>
      <Text numberOfLines={1} style={[styles.detailValue, muted ? styles.detailValueMuted : null]}>
        {value}
      </Text>
      {chevron ? <Ionicons color={colors.slate} name="chevron-forward" size={14} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  appName: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
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
    paddingHorizontal: spacing.xxxl,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  detailLabel: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  detailRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
  detailValue: {
    color: colors.basalt,
    flexShrink: 1,
    textAlign: "right",
    ...typography.secondaryBody,
  },
  detailValueMuted: {
    color: colors.slate,
  },
  divider: {
    marginLeft: spacing.md,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  headerBody: {
    flex: 1,
    gap: 4,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.sectionTitle,
  },
  hint: {
    backgroundColor: "rgba(226,223,217,0.55)",
    borderRadius: radii.card,
    gap: 6,
    padding: 14,
  },
  hintBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  hintTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  muted: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  openBody: {
    flex: 1,
    gap: 2,
  },
  openCard: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    padding: 14,
  },
  openTitle: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  openUrl: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  pressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
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
  stateText: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  statusLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  statusText: {
    color: colors.basalt,
    ...typography.caption,
  },
});
