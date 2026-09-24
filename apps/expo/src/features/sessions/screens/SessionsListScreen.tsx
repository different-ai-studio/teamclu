import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { SkeletonRow } from "../../../ui/atoms/SkeletonRow";
import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { PageHeader } from "../../../ui/PageHeader";
import { TextPromptModal } from "../../../ui/TextPromptModal";
import { impactLight, selectionTick } from "../../../lib/haptics";
import { t } from "../../../lib/i18n";
import { colors, spacing, typography } from "../../../ui/theme";
import { matchesAnyField } from "../../search/search-matcher";
import { DaemonStatusBanner, type DaemonConnectionState } from "../components/DaemonStatusBanner";
import { SessionRow, type SessionRowRuntime } from "../components/SessionRow";
import type { SessionLiveActivity } from "../live-activity";
import type { SessionGroup, SessionsListState } from "../session-types";

type SessionsListScreenProps = {
  /** Extra bottom inset so content clears the floating tab bar. */
  bottomInset?: number;
  onArchiveBatch?: (sessionIds: string[]) => Promise<void>;
  actorGlyphById?: ReadonlyMap<string, string>;
  hasAgents?: boolean;
  onInviteAgent?: () => void;
  onLoad: () => void;
  onMarkBatchRead?: (sessionIds: string[]) => Promise<void>;
  onMarkBatchUnread?: (sessionIds: string[]) => Promise<void>;
  onNewSession?: () => void;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => Promise<void> | void;
  /** iOS context menu "Rename" — `PATCH /v1/sessions/{id}`. */
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void;
  /** iOS context menu "Mute / Unmute notifications". */
  onToggleMute?: (sessionId: string, muted: boolean) => Promise<void> | void;
  pinnedSessionIds?: ReadonlySet<string>;
  /** Live runtime attachment per session — drives the badge dot and status label. */
  runtimeBySessionId?: ReadonlyMap<string, SessionRowRuntime>;
  /** Workspace/worktree name per session, shown at the head of the meta strip. */
  workspaceBySessionId?: ReadonlyMap<string, string>;
  mutedSessionIds?: ReadonlySet<string>;
  /** "Agent working" / "waiting for you" per session (iOS #1567). */
  activityBySessionId?: ReadonlyMap<string, SessionLiveActivity>;
  /** Daemon reachability, shown as a pill above the search field. */
  daemonConnectionState?: DaemonConnectionState;
  brokerHost?: string;
  onShortcuts?: () => void;
  selectedSessionId?: string | null;
  state: SessionsListState;
};

export function SessionGroupSection({
  actorGlyphById,
  group,
  mutedSessionIds,
  activityBySessionId,
  onLongPressSession,
  onSelectSession,
  pinnedSessionIds,
  runtimeBySessionId,
  selectedSessionId,
  selectionMode,
  selection,
  workspaceBySessionId,
}: {
  actorGlyphById?: ReadonlyMap<string, string>;
  group: SessionGroup;
  mutedSessionIds?: ReadonlySet<string>;
  activityBySessionId?: ReadonlyMap<string, SessionLiveActivity>;
  onLongPressSession?: (id: string) => void;
  onSelectSession: (sessionId: string) => void;
  pinnedSessionIds?: ReadonlySet<string>;
  runtimeBySessionId?: ReadonlyMap<string, SessionRowRuntime>;
  selectedSessionId: string | null;
  selectionMode: boolean;
  selection: ReadonlySet<string>;
  workspaceBySessionId?: ReadonlyMap<string, string>;
}) {
  // `t()` here (not `useTranslation()`) deliberately: this component is
  // exercised in tests by calling it as a plain function outside of a React
  // render pass, where hooks have no dispatcher to attach to.
  return (
    <View style={styles.group}>
      <SectionEyebrow label={t(group.label)} style={styles.groupLabel} />
      <View style={styles.groupItems}>
        {group.sessions.map((session, index) => {
          const checked = selection.has(session.sessionId);
          return (
            <View
              key={session.sessionId}
              style={[styles.sessionRowOuter, checked ? styles.sessionRowChecked : null]}
            >
              <View style={styles.sessionRowInner}>
                {selectionMode ? (
                  <View style={[styles.checkbox, checked ? styles.checkboxOn : null]}>
                    {checked ? (
                      <Ionicons color="#F8F6F1" name="checkmark" size={14} />
                    ) : null}
                  </View>
                ) : null}
                <View style={{ flex: 1 }}>
                  <SessionRow
                    actorGlyphById={actorGlyphById}
                    isActive={selectedSessionId === session.sessionId}
                    isMuted={mutedSessionIds?.has(session.sessionId) ?? false}
                    activity={activityBySessionId?.get(session.sessionId) ?? "quiet"}
                    isPinned={pinnedSessionIds?.has(session.sessionId) ?? false}
                    runtime={runtimeBySessionId?.get(session.sessionId) ?? null}
                    workspaceName={workspaceBySessionId?.get(session.sessionId) ?? ""}
                    onLongPress={
                      onLongPressSession
                        ? () => onLongPressSession(session.sessionId)
                        : undefined
                    }
                    onPress={(s) => onSelectSession(s.sessionId)}
                    session={session}
                  />
                </View>
              </View>
              {index < group.sessions.length - 1 ? (
                <Hairline style={styles.rowDivider} />
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function HeaderBar({
  onNewSession,
  onShortcuts,
}: {
  onNewSession: () => void;
  onShortcuts: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PageHeader
      left={
        <Pressable onPress={onShortcuts} hitSlop={8} style={styles.toolbarButton}>
          <Ionicons name="grid-outline" size={22} color={colors.onyx} />
        </Pressable>
      }
      right={
        <Pressable onPress={onNewSession} hitSlop={8} style={styles.toolbarButton}>
          <Ionicons name="create-outline" size={24} color={colors.onyx} />
        </Pressable>
      }
      title={t("Sessions")}
    />
  );
}

export function SessionsListScreen({
  bottomInset = 0,
  actorGlyphById,
  brokerHost,
  daemonConnectionState,
  hasAgents = true,
  onArchiveBatch,
  onInviteAgent,
  onLoad,
  onMarkBatchRead,
  onMarkBatchUnread,
  onNewSession,
  onRefresh,
  onSelectSession,
  onShortcuts,
  onTogglePin,
  onRenameSession,
  onToggleMute,
  mutedSessionIds,
  activityBySessionId,
  pinnedSessionIds,
  runtimeBySessionId,
  selectedSessionId = null,
  state,
  workspaceBySessionId,
}: SessionsListScreenProps) {
  const { t } = useTranslation();
  const [placeholderMessage, setPlaceholderMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const selectionMode = selection.size > 0;
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const toggleSelection = (id: string) => {
    selectionTick();
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelection(new Set());

  const sessionTitle = useCallback(
    (sessionId: string) =>
      state.groups
        .flatMap((group) => group.sessions)
        .find((session) => session.sessionId === sessionId)?.title ?? "",
    [state.groups],
  );

  const showRowContextMenu = useCallback(
    (sessionId: string) => {
      impactLight();
      const isPinned = pinnedSessionIds?.has(sessionId) ?? false;
      const isMuted = mutedSessionIds?.has(sessionId) ?? false;
      // Built as a list so adding an action can't shift another's index.
      const actions: Array<{ label: string; destructive?: boolean; run: () => void }> = [
        { label: isPinned ? t("Unpin") : t("Pin"), run: () => void onTogglePin?.(sessionId) },
        ...(onRenameSession
          ? [{ label: t("Rename"), run: () => setRenameTarget({ id: sessionId, title: sessionTitle(sessionId) }) }]
          : []),
        ...(onToggleMute
          ? [{
              label: isMuted ? t("Unmute notifications") : t("Mute notifications"),
              run: () => void onToggleMute(sessionId, !isMuted),
            }]
          : []),
        { label: t("Mark as unread"), run: () => void onMarkBatchUnread?.([sessionId]) },
        { label: t("Mark as read"), run: () => void onMarkBatchRead?.([sessionId]) },
        { label: t("Archive"), destructive: true, run: () => void onArchiveBatch?.([sessionId]) },
        { label: t("More…"), run: () => toggleSelection(sessionId) },
      ];
      const cancelLabel = t("Cancel");
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [...actions.map((a) => a.label), cancelLabel],
            cancelButtonIndex: actions.length,
            destructiveButtonIndex: actions.findIndex((a) => a.destructive),
          },
          (index) => actions[index]?.run(),
        );
        return;
      }
      Alert.alert(t("Session actions"), undefined, [
        ...actions.map((a) => ({
          text: a.label,
          style: a.destructive ? ("destructive" as const) : undefined,
          onPress: a.run,
        })),
        { text: cancelLabel, style: "cancel" as const },
      ]);
    },
    [
      pinnedSessionIds,
      mutedSessionIds,
      onTogglePin,
      onRenameSession,
      onToggleMute,
      onMarkBatchUnread,
      onMarkBatchRead,
      onArchiveBatch,
      sessionTitle,
    ],
  );
  const handleArchiveSelected = async () => {
    if (!onArchiveBatch || selection.size === 0) return;
    setIsBatchBusy(true);
    try {
      await onArchiveBatch(Array.from(selection));
      clearSelection();
    } finally {
      setIsBatchBusy(false);
    }
  };

  const handleMarkReadSelected = async () => {
    if (!onMarkBatchRead || selection.size === 0) return;
    setIsBatchBusy(true);
    try {
      await onMarkBatchRead(Array.from(selection));
      clearSelection();
    } finally {
      setIsBatchBusy(false);
    }
  };

  const handleMarkUnreadSelected = async () => {
    if (!onMarkBatchUnread || selection.size === 0) return;
    setIsBatchBusy(true);
    try {
      await onMarkBatchUnread(Array.from(selection));
      clearSelection();
    } finally {
      setIsBatchBusy(false);
    }
  };

  const filteredGroups = useMemo<SessionGroup[]>(() => {
    const filtered =
      query.trim().length === 0
        ? state.groups
        : state.groups
            .map((group) => ({
              ...group,
              sessions: group.sessions.filter((session) =>
                matchesAnyField(
                  [session.title, session.summary, session.lastMessagePreview],
                  query,
                ),
              ),
            }))
            .filter((group) => group.sessions.length > 0);

    if (!pinnedSessionIds || pinnedSessionIds.size === 0) return filtered;
    const pinned: SessionGroup["sessions"] = [];
    const rest: SessionGroup = { label: "Today", sessions: [] };
    const remainingGroups: SessionGroup[] = [];
    for (const group of filtered) {
      const remaining: SessionGroup["sessions"] = [];
      for (const session of group.sessions) {
        if (pinnedSessionIds.has(session.sessionId)) pinned.push(session);
        else remaining.push(session);
      }
      if (remaining.length > 0) remainingGroups.push({ ...group, sessions: remaining });
    }
    if (pinned.length === 0) return remainingGroups;
    const pinnedGroup: SessionGroup = { label: "Today", sessions: pinned };
    // Reuse the existing eyebrow look but force a synthetic group label.
    (pinnedGroup as unknown as { label: string }).label = `PINNED · ${pinned.length}`;
    void rest;
    return [pinnedGroup, ...remainingGroups];
  }, [state.groups, query, pinnedSessionIds]);

  const handleNewSession = () => {
    if (onNewSession) {
      onNewSession();
      return;
    }
    setPlaceholderMessage(t("New session — coming next."));
  };

  const handleShortcuts = () => {
    if (onShortcuts) {
      onShortcuts();
      return;
    }
    setPlaceholderMessage(t("Shortcuts drawer — coming with the Shortcuts sub-spec."));
  };

  const headerBar = (
    <HeaderBar
      onNewSession={handleNewSession}
      onShortcuts={handleShortcuts}
    />
  );

  if (state.status === "loading" || (state.status === "idle" && state.sessions.length === 0)) {
    return (
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]}
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={state.isRefreshing}
            tintColor={colors.slate}
          />
        }
        style={styles.screen}
      >
        {headerBar}
        {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
        <View>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.sessions.length === 0) {
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]} style={styles.screen}>
        {headerBar}
        {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>{t("Couldn't load sessions")}</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? t("Try again in a moment.")}</Text>
          <PrimaryButton
            fullWidth={false}
            isLoading={state.isLoading}
            label={t("Retry")}
            onPress={onLoad}
          />
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={state.isRefreshing}
          tintColor={colors.slate}
        />
      }
      style={{ flex: 1 }}
    >
      {headerBar}
      {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}

      {state.status === "error" && state.errorMessage ? (
        <AppCard compact style={styles.banner}>
          <Text style={styles.bannerText}>{state.errorMessage}</Text>
        </AppCard>
      ) : null}

      {daemonConnectionState ? (
        <View style={styles.daemonBanner}>
          <DaemonStatusBanner
            brokerHost={brokerHost}
            connectionState={daemonConnectionState}
          />
        </View>
      ) : null}

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t("Search sessions")}
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel={t("Clear search")}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setQuery("")}
          >
            <Ionicons color={colors.slate} name="close-circle" size={16} />
          </Pressable>
        ) : null}
      </View>

      {filteredGroups.length > 0 ? (
        <View style={styles.groups}>
          {filteredGroups.map((group) => (
            <SessionGroupSection
              actorGlyphById={actorGlyphById}
              group={group}
              key={group.label}
              onLongPressSession={(id) => {
                if (selectionMode) {
                  toggleSelection(id);
                } else {
                  showRowContextMenu(id);
                }
              }}
              onSelectSession={(id) => {
                if (selectionMode) {
                  toggleSelection(id);
                } else {
                  onSelectSession(id);
                }
              }}
              mutedSessionIds={mutedSessionIds}
              activityBySessionId={activityBySessionId}
              pinnedSessionIds={pinnedSessionIds}
              runtimeBySessionId={runtimeBySessionId}
              selectedSessionId={selectedSessionId}
              selection={selection}
              selectionMode={selectionMode}
              workspaceBySessionId={workspaceBySessionId}
            />
          ))}
        </View>
      ) : (
        <View style={styles.stateBlock}>
          {!hasAgents && onInviteAgent ? (
            <>
              <Text style={styles.stateTitle}>{t("Invite your first agent")}</Text>
              <Text style={styles.stateBody}>
                {t("You don't have access to any agent in this team yet. Invite one to start a session.")}
              </Text>
              <PrimaryButton
                fullWidth={false}
                label={t("Invite agent")}
                onPress={onInviteAgent}
              />
            </>
          ) : (
            <>
              <Text style={styles.stateTitle}>{t("No Sessions")}</Text>
              <Text style={styles.stateBody}>{t("Start a new session to begin")}</Text>
            </>
          )}
        </View>
      )}
    </ScrollView>

    {selectionMode ? (
      <View style={styles.batchBar}>
        <Text style={styles.batchCount}>{t("{{count}} selected", { count: selection.size })}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={clearSelection}
          style={({ pressed }) => [styles.batchAction, pressed ? styles.batchActionPressed : null]}
        >
          <Text style={styles.batchActionText}>{t("Cancel")}</Text>
        </Pressable>
        {onTogglePin ? (
          <Pressable
            accessibilityRole="button"
            disabled={isBatchBusy}
            onPress={async () => {
              for (const id of selection) await onTogglePin(id);
              clearSelection();
            }}
            style={({ pressed }) => [
              styles.batchAction,
              pressed && !isBatchBusy ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>{t("Pin")}</Text>
          </Pressable>
        ) : null}
        {onMarkBatchRead ? (
          <Pressable
            accessibilityRole="button"
            disabled={isBatchBusy}
            onPress={handleMarkReadSelected}
            style={({ pressed }) => [
              styles.batchAction,
              pressed && !isBatchBusy ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>{t("Mark read")}</Text>
          </Pressable>
        ) : null}
        {onMarkBatchUnread ? (
          <Pressable
            accessibilityRole="button"
            disabled={isBatchBusy}
            onPress={handleMarkUnreadSelected}
            style={({ pressed }) => [
              styles.batchAction,
              pressed && !isBatchBusy ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>{t("Mark unread")}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={isBatchBusy || !onArchiveBatch}
          onPress={handleArchiveSelected}
          style={({ pressed }) => [
            styles.batchPrimary,
            isBatchBusy ? styles.batchPrimaryBusy : null,
            pressed && !isBatchBusy ? styles.batchActionPressed : null,
          ]}
        >
          <Text style={styles.batchPrimaryText}>
            {isBatchBusy ? t("Archiving…") : t("Archive")}
          </Text>
        </Pressable>
      </View>
    ) : null}
    <TextPromptModal
      initialValue={renameTarget?.title ?? ""}
      isVisible={renameTarget !== null}
      key={renameTarget?.id ?? "rename"}
      onCancel={() => setRenameTarget(null)}
      onSubmit={(value) => {
        const target = renameTarget;
        setRenameTarget(null);
        const title = value.trim();
        if (target && title && title !== target.title) void onRenameSession?.(target.id, title);
      }}
      placeholder={t("Title")}
      title={t("Rename Session")}
    />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    marginHorizontal: spacing.lg,
  },
  bannerText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  content: {
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  feedback: {
    color: colors.slate,
    paddingHorizontal: spacing.lg,
    ...typography.caption,
  },
  group: {
    gap: spacing.sm,
  },
  groupItems: {},
  groupLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  groups: {
    gap: spacing.lg,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowDivider: {
    marginLeft: 54,
  },
  batchAction: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  batchActionPressed: {
    opacity: 0.7,
  },
  batchActionText: {
    color: colors.basalt,
    ...typography.body,
  },
  batchBar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  batchCount: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
    fontWeight: "600",
  },
  batchPrimary: {
    backgroundColor: "rgba(184,75,54,0.12)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  batchPrimaryBusy: {
    opacity: 0.5,
  },
  batchPrimaryText: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "700",
  },
  checkbox: {
    alignItems: "center",
    borderColor: colors.slate,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    marginLeft: spacing.lg,
    width: 22,
  },
  checkboxOn: {
    backgroundColor: colors.cinnabar,
    borderColor: colors.cinnabar,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  sessionRowChecked: {
    backgroundColor: "rgba(184,75,54,0.06)",
  },
  sessionRowOuter: {
  },
  sessionRowInner: {
    alignItems: "center",
    flexDirection: "row",
  },
  daemonBanner: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  stateBlock: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  toolbarButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
});
