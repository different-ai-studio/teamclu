import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { createConfiguredShortcutsApi } from "./api-provider";
import { createConfiguredTeamAppsApi } from "../apps/team-apps-api";
import {
  isLeafShortcut,
  type Shortcut,
  type ShortcutScope,
} from "./shortcut-types";
import { supabase } from "../../lib/supabase/client";
import { Hairline } from "../../ui/atoms/Hairline";
import { colors, hai, radii, spacing, typography } from "../../ui/theme";

export type ShortcutsDrawerProps = {
  isPresented: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcut: (shortcut: Shortcut) => void;
  teamId: string;
  profileName: string;
  profileSubtitle?: string | null;
  /**
   * Whether the team-apps entry is shown (bootstrap `features.apps`). Off
   * hides the pinned apps section entirely.
   */
  appsEnabled?: boolean;
  onOpenApps?: () => void;
};

const ANIMATION_DURATION = 240;

/**
 * 1:1 port of `apps/ios/.../ShortcutsDrawer.swift`. Left-edge drawer:
 *   • Onyx-tinted backdrop (tap to close, drag-back closes via overlay press)
 *   • Profile header (avatar + name + subtitle)
 *   • Personal + Team scoped sections, loaded from Supabase
 *   • Settings footer at the bottom with app version
 *
 * Lifts the drawer surface so it cannot live as a separate route — the
 * sessions screen owns the open/close state and routes settings + shortcut
 * taps through the drawer back to the host so the host can dismiss us.
 */
export function ShortcutsDrawer({
  isPresented,
  onClose,
  onOpenSettings,
  onOpenShortcut,
  teamId,
  profileName,
  profileSubtitle,
  appsEnabled = false,
  onOpenApps,
}: ShortcutsDrawerProps) {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const drawerWidth = Math.min(360, screenWidth * 0.86);

  // Off-screen on the left when closed; slides to 0 when open.
  const translateX = useRef(new Animated.Value(-drawerWidth)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(isPresented);

  useEffect(() => {
    if (isPresented) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: ANIMATION_DURATION,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 1,
          duration: ANIMATION_DURATION,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: -drawerWidth,
          duration: ANIMATION_DURATION,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 0,
          duration: ANIMATION_DURATION,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [isPresented, drawerWidth, translateX, backdrop]);

  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPresented || !teamId) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await createConfiguredShortcutsApi(supabase).listShortcuts(teamId);
        if (!cancelled) setShortcuts(rows);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : t("Couldn't load shortcuts."),
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPresented, teamId]);

  // Team apps count for the pinned foot. Null until the first answer, so the
  // "create your first app" pitch does not flash before it.
  const [appsCount, setAppsCount] = useState<number | null>(null);
  const showApps = appsEnabled && Boolean(onOpenApps);

  useEffect(() => {
    if (!isPresented || !teamId || !showApps) return;
    let cancelled = false;
    void (async () => {
      try {
        const apps = await createConfiguredTeamAppsApi(supabase).listApps(teamId);
        if (!cancelled) setAppsCount(apps.length);
      } catch {
        // Keep whatever count we had; the row still opens the list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPresented, teamId, showApps]);

  // Folders expand in place, as iOS `ShortcutMenuRow` does. Without this a
  // folder row was visible, tappable and inert — `openShortcutTarget` has no
  // folder branch, so nothing happened at all.
  //
  // These hooks must stay above the `mounted` early-return: when the drawer
  // was closed the component returned before reaching them, then opening it
  // added hooks mid-lifetime ("Rendered more hooks than during the previous
  // render").
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Shortcut[]>();
    for (const row of shortcuts) {
      if (!row.parentId) continue;
      const bucket = map.get(row.parentId);
      if (bucket) bucket.push(row);
      else map.set(row.parentId, [row]);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.order - b.order);
    return map;
  }, [shortcuts]);

  if (!mounted) return null;

  const handleSettings = () => {
    onClose();
    setTimeout(() => onOpenSettings(), ANIMATION_DURATION + 16);
  };

  const handleOpenApps = () => {
    onClose();
    setTimeout(() => onOpenApps?.(), ANIMATION_DURATION + 16);
  };

  const handleOpenShortcut = (shortcut: Shortcut) => {
    onClose();
    setTimeout(() => onOpenShortcut(shortcut), ANIMATION_DURATION + 16);
  };

  const toggleFolder = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const personalRoots = shortcuts
    .filter((row) => row.scope === "personal" && row.parentId === null)
    .sort((a, b) => a.order - b.order);
  const teamRoots = shortcuts
    .filter((row) => row.scope === "team" && row.parentId === null)
    .sort((a, b) => a.order - b.order);
  const isEmpty = personalRoots.length === 0 && teamRoots.length === 0;

  const appVersion = Constants.expoConfig?.version
    ? `v${Constants.expoConfig.version}`
    : null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        pointerEvents={isPresented ? "auto" : "none"}
        style={[
          styles.backdrop,
          {
            opacity: backdrop.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 0.22],
            }),
          },
        ]}
      >
        <Pressable
          accessibilityLabel={t("Close shortcuts")}
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View
        pointerEvents={isPresented ? "auto" : "none"}
        style={[
          styles.drawer,
          {
            paddingTop: insets.top,
            transform: [{ translateX }],
            width: drawerWidth,
          },
        ]}
      >
        <ProfileHeader
          displayName={profileName}
          subtitle={profileSubtitle ?? null}
        />

        <ScrollView
          contentContainerStyle={styles.listContent}
          style={styles.list}
        >
          {isLoading && isEmpty ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.basalt} />
            </View>
          ) : isEmpty ? (
            <View style={styles.emptyState}>
              <Ionicons color={colors.basalt} name="star-outline" size={40} />
              <Text style={styles.emptyTitle}>{t("No Shortcuts")}</Text>
              <Text style={styles.emptyBody}>
                {t("Shortcuts you or your team create will appear here.")}
              </Text>
            </View>
          ) : (
            <>
              {personalRoots.length > 0 ? (
                <ShortcutSection
                  childrenByParent={childrenByParent}
                  count={personalRoots.length}
                  expandedIds={expandedIds}
                  onOpen={handleOpenShortcut}
                  onToggleFolder={toggleFolder}
                  rows={personalRoots}
                  title={t("Personal")}
                />
              ) : null}
              {teamRoots.length > 0 ? (
                <ShortcutSection
                  childrenByParent={childrenByParent}
                  count={teamRoots.length}
                  expandedIds={expandedIds}
                  onOpen={handleOpenShortcut}
                  onToggleFolder={toggleFolder}
                  rows={teamRoots}
                  title={t("Team")}
                />
              ) : null}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </>
          )}
        </ScrollView>

        {/* Pinned, not the last row of the scroll view: it is the drawer's one
            destination outside shortcuts, and a team with enough of them
            would scroll it off the bottom. */}
        {showApps ? (
          <View style={styles.apps}>
            <Hairline />
            {appsCount === 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleOpenApps}
                style={({ pressed }) => [
                  styles.appsPromo,
                  pressed ? styles.footerRowPressed : null,
                ]}
              >
                <View style={styles.appsPromoHead}>
                  <Ionicons color={colors.basalt} name="grid-outline" size={14} />
                  <Text style={styles.appsPromoEyebrow}>{t("Team apps")}</Text>
                </View>
                <Text style={styles.appsPromoTitle}>{t("Create your first app")}</Text>
                <Text style={styles.appsPromoBody}>
                  {t(
                    "Build a small tool or page for your team. Teammates can open it directly, and agents can help maintain it.",
                  )}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel={t("Team apps")}
                accessibilityRole="button"
                onPress={handleOpenApps}
                style={({ pressed }) => [
                  styles.appsRow,
                  pressed ? styles.footerRowPressed : null,
                ]}
              >
                <Ionicons
                  color={colors.basalt}
                  name="grid-outline"
                  size={16}
                  style={styles.footerIcon}
                />
                <Text style={styles.footerLabel}>{t("Team apps")}</Text>
                <View style={styles.footerSpacer} />
                {appsCount ? (
                  <Text style={styles.footerVersion}>{appsCount}</Text>
                ) : null}
                <Ionicons color={colors.slate} name="chevron-forward" size={14} />
              </Pressable>
            )}
          </View>
        ) : null}

        <View style={styles.footer}>
          <Hairline />
          <Pressable
            accessibilityLabel={t("Settings")}
            accessibilityRole="button"
            onPress={handleSettings}
            style={({ pressed }) => [
              styles.footerRow,
              pressed ? styles.footerRowPressed : null,
              { paddingBottom: 14 + Math.max(insets.bottom - 4, 0) },
            ]}
          >
            <Ionicons
              color={colors.basalt}
              name="settings-outline"
              size={18}
              style={styles.footerIcon}
            />
            <Text style={styles.footerLabel}>{t("Settings")}</Text>
            <View style={styles.footerSpacer} />
            {appVersion ? (
              <Text style={styles.footerVersion}>{appVersion}</Text>
            ) : null}
            <Ionicons
              color={colors.slate}
              name="chevron-forward"
              size={14}
            />
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

function ProfileHeader({
  displayName,
  subtitle,
}: {
  displayName: string;
  subtitle: string | null;
}) {
  const initial = displayName.trim().charAt(0).toUpperCase() || "·";
  return (
    <View style={styles.profile}>
      <View style={styles.profileRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.profileBody}>
          <Text numberOfLines={1} style={styles.profileName}>
            {displayName}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={styles.profileSubtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <Hairline style={styles.profileDivider} />
    </View>
  );
}

function ShortcutSection({
  childrenByParent,
  count,
  expandedIds,
  onOpen,
  onToggleFolder,
  rows,
  title,
}: {
  childrenByParent: ReadonlyMap<string, Shortcut[]>;
  count: number;
  expandedIds: ReadonlySet<string>;
  onOpen: (shortcut: Shortcut) => void;
  onToggleFolder: (id: string) => void;
  rows: Shortcut[];
  title: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader}>
        {title.toUpperCase()} · {count}
      </Text>
      <View>
        {rows.map((row) => (
          <ShortcutTree
            childrenByParent={childrenByParent}
            depth={0}
            expandedIds={expandedIds}
            key={row.id}
            onOpen={onOpen}
            onToggleFolder={onToggleFolder}
            row={row}
          />
        ))}
      </View>
    </View>
  );
}

/** Indent per level, matching iOS `ShortcutRowMetrics.childIndent`. */
const CHILD_INDENT = 22;

function ShortcutTree({
  childrenByParent,
  depth,
  expandedIds,
  onOpen,
  onToggleFolder,
  row,
}: {
  childrenByParent: ReadonlyMap<string, Shortcut[]>;
  depth: number;
  expandedIds: ReadonlySet<string>;
  onOpen: (shortcut: Shortcut) => void;
  onToggleFolder: (id: string) => void;
  row: Shortcut;
}) {
  const { t } = useTranslation();
  const isFolder = row.nodeType === "folder";
  const isExpanded = expandedIds.has(row.id);
  const children = isFolder ? childrenByParent.get(row.id) ?? [] : [];

  return (
    <View>
      <ShortcutRow
        depth={depth}
        isExpanded={isExpanded}
        onPress={() => (isFolder ? onToggleFolder(row.id) : onOpen(row))}
        row={row}
      />
      {isFolder && isExpanded ? (
        children.length === 0 ? (
          <Text style={[styles.shortcutEmpty, { paddingLeft: (depth + 1) * CHILD_INDENT + 12 }]}>
            {t("Empty")}
          </Text>
        ) : (
          children.map((child) => (
            <ShortcutTree
              childrenByParent={childrenByParent}
              depth={depth + 1}
              expandedIds={expandedIds}
              key={child.id}
              onOpen={onOpen}
              onToggleFolder={onToggleFolder}
              row={child}
            />
          ))
        )
      ) : null}
    </View>
  );
}

function ShortcutRow({
  depth,
  isExpanded,
  onPress,
  row,
}: {
  depth: number;
  isExpanded: boolean;
  onPress: () => void;
  row: Shortcut;
}) {
  const isFolder = row.nodeType === "folder";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={isFolder ? { expanded: isExpanded } : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.shortcutRow,
        { paddingLeft: 12 + depth * CHILD_INDENT },
        pressed ? styles.shortcutRowPressed : null,
      ]}
    >
      {/* Children are plain indented text — no icon, no chevron, as iOS does. */}
      {depth === 0 ? (
        <View style={styles.shortcutIcon}>
          <Ionicons color={colors.basalt} name={iconForNode(row)} size={15} />
        </View>
      ) : null}
      <Text numberOfLines={1} style={styles.shortcutLabel}>
        {row.label}
      </Text>
      <View style={styles.footerSpacer} />
      {depth === 0 ? (
        isFolder ? (
          <Ionicons
            color={colors.slate}
            name={isExpanded ? "chevron-down" : "chevron-forward"}
            size={14}
          />
        ) : (
          <Ionicons color={colors.slate} name="open-outline" size={14} />
        )
      ) : null}
    </Pressable>
  );
}

function iconForNode(
  row: Shortcut,
): React.ComponentProps<typeof Ionicons>["name"] {
  switch (row.nodeType) {
    case "folder":
      return "folder-outline";
    case "session":
      return "chatbubbles-outline";
    case "team":
      return "people-outline";
    case "external":
      return "link-outline";
    case "url":
    default:
      return "globe-outline";
  }
}

export async function openShortcutTarget(
  shortcut: Shortcut,
  router: {
    push: (href: string | { pathname: string; params: Record<string, string> }) => void;
  },
) {
  if (!shortcut.target) return;
  if (shortcut.nodeType === "session") {
    router.push(`/(app)/sessions/${shortcut.target}`);
    return;
  }
  if (shortcut.nodeType === "url" || shortcut.nodeType === "external") {
    if (!isWebUrl(shortcut.target)) return;
    router.push({
      pathname: "/(app)/shortcut-web",
      params: { url: shortcut.target, title: shortcut.label },
    });
    return;
  }
}

/**
 * Only `http(s)` reaches the WebView — iOS `ShortcutPresentation.destination`
 * makes the same check and returns `.disabled` for everything else.
 *
 * Shortcut targets are team data: anyone who can create a shortcut chooses the
 * string, and it was being handed to `WebView source={{ uri }}` unexamined. A
 * `javascript:` or `file:` target is not a link, and the check belongs here
 * rather than in the WebView, so a bad target renders as an inert row instead
 * of opening a screen that then fails.
 */
export function isWebUrl(target: string | null | undefined): boolean {
  if (!target) return false;
  try {
    const scheme = new URL(target).protocol.toLowerCase();
    return scheme === "http:" || scheme === "https:";
  } catch {
    // Not absolute, so there is no scheme to trust.
    return false;
  }
}

const styles = StyleSheet.create({
  apps: {
    backgroundColor: colors.mist,
  },
  appsPromo: {
    backgroundColor: "rgba(226,223,217,0.5)",
    borderRadius: radii.card,
    gap: 7,
    marginHorizontal: 16,
    marginVertical: 10,
    padding: 14,
  },
  appsPromoBody: {
    color: colors.slate,
    ...typography.caption,
  },
  appsPromoEyebrow: {
    color: colors.basalt,
    fontSize: 13,
    fontWeight: "600",
  },
  appsPromoHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  appsPromoTitle: {
    color: colors.onyx,
    fontSize: 15,
    fontWeight: "600",
  },
  appsRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 44,
    paddingRight: 18,
    paddingVertical: 8,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  avatarText: {
    color: colors.onyx,
    fontSize: 17,
    fontWeight: "600",
  },
  backdrop: {
    backgroundColor: colors.onyx,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  drawer: {
    backgroundColor: colors.mist,
    borderRightColor: colors.hairline,
    borderRightWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
  },
  emptyBody: {
    color: colors.basalt,
    paddingHorizontal: 16,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  emptyState: {
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: 24,
    paddingTop: 56,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
    fontSize: 17,
    fontWeight: "600",
  },
  errorText: {
    color: colors.slate,
    paddingHorizontal: 20,
    paddingTop: spacing.sm,
    ...typography.caption,
  },
  footer: {
    backgroundColor: colors.mist,
  },
  footerIcon: {
    paddingLeft: 18,
    width: 36,
  },
  footerLabel: {
    color: colors.onyx,
    paddingLeft: 6,
    ...typography.body,
    fontSize: 15,
  },
  footerRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 50,
    paddingRight: 18,
    paddingTop: 14,
  },
  footerRowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  footerSpacer: {
    flex: 1,
  },
  footerVersion: {
    color: colors.slate,
    paddingHorizontal: 6,
    ...typography.monoMeta,
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: 16,
    paddingBottom: 16,
    paddingTop: 16,
  },
  profile: {
    backgroundColor: colors.mist,
  },
  profileBody: {
    flex: 1,
    gap: 2,
  },
  profileDivider: {
    marginHorizontal: 20,
  },
  profileName: {
    color: colors.onyx,
    fontSize: 17,
    fontWeight: "600",
  },
  profileRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    paddingBottom: 14,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  profileSubtitle: {
    color: colors.slate,
    fontSize: 13,
  },
  section: {
    gap: 4,
  },
  sectionHeader: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.4,
    paddingBottom: 2,
    paddingHorizontal: 20,
    textTransform: "uppercase",
  },
  shortcutIcon: {
    alignItems: "center",
    paddingLeft: 18,
    width: 36,
  },
  shortcutEmpty: {
    color: colors.slate,
    opacity: 0.7,
    paddingVertical: 8,
    ...typography.caption,
  },
  shortcutLabel: {
    color: colors.onyx,
    paddingLeft: 6,
    ...typography.body,
    fontSize: 15,
  },
  shortcutRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 44,
    paddingRight: 18,
    paddingVertical: 8,
  },
  shortcutRowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
});
