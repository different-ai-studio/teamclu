import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { FlashList } from "@shopify/flash-list";
import {
  Keyboard,
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
import { showActionSheet } from "../../../ui/action-sheet";
import { TextPromptModal } from "../../../ui/TextPromptModal";
import { impactLight, selectionTick } from "../../../lib/haptics";
import { t } from "../../../lib/i18n";
import { colors, spacing, typography } from "../../../ui/theme";
import { matchesAnyField } from "../../search/search-matcher";
import { SessionRow, type SessionRowRuntime } from "../components/SessionRow";
import { endChatMetric, markChatMetric } from "../../../lib/telemetry/chat-metrics";
import { MESSAGE_SEARCH_MIN_LENGTH } from "../message-actions";
import {
  getComposerDraftsSnapshot,
  hydrateComposerDrafts,
  subscribeComposerDrafts,
} from "../composer-drafts";
import type { SessionLiveActivity } from "../live-activity";
import type { SessionContext } from "../session-context-names";
import type { SessionGroup, SessionSummary, SessionsListState } from "../session-types";

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
  /** App or idea per session, shown at the head of the meta strip (iOS #1597). */
  contextBySessionId?: ReadonlyMap<string, SessionContext>;
  mutedSessionIds?: ReadonlySet<string>;
  /** "Agent working" / "waiting for you" per session (iOS #1567). */
  activityBySessionId?: ReadonlyMap<string, SessionLiveActivity>;
  onShortcuts?: () => void;
  selectedSessionId?: string | null;
  state: SessionsListState;
  /**
   * Sessions whose cached messages contain the query (iOS #1709): the list
   * search also finds a session by what was said in it, not only its title.
   */
  searchMessageContent?: (query: string) => Promise<ReadonlySet<string>>;
};

/** How long the list waits for rows before showing a loading skeleton. */
const SKELETON_DELAY_MS = 400;

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
  contextBySessionId,
  draftBySessionId,
}: {
  actorGlyphById?: ReadonlyMap<string, string>;
  /** Unsent composer text per session; the row previews it as "Draft: …". */
  draftBySessionId?: ReadonlyMap<string, string>;
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
  contextBySessionId?: ReadonlyMap<string, SessionContext>;
}) {
  // `t()` here (not `useTranslation()`) deliberately: this component is
  // exercised in tests by calling it as a plain function outside of a React
  // render pass, where hooks have no dispatcher to attach to.
  const rowProps: SessionListRowProps = {
    actorGlyphById,
    activityBySessionId,
    contextBySessionId,
    draftBySessionId,
    mutedSessionIds,
    onLongPressSession,
    onSelectSession,
    pinnedSessionIds,
    runtimeBySessionId,
    selectedSessionId,
    selection,
    selectionMode,
  };
  return (
    <View style={styles.group}>
      <SectionEyebrow label={t(group.label)} style={styles.groupLabel} />
      <View style={styles.groupItems}>
        {group.sessions.map((session, index) =>
          renderSessionListRow(session, index === group.sessions.length - 1, rowProps),
        )}
      </View>
    </View>
  );
}

type SessionListItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "row"; key: string; session: SessionSummary; isLastInGroup: boolean };

type SessionListRowProps = {
  actorGlyphById?: ReadonlyMap<string, string>;
  activityBySessionId?: ReadonlyMap<string, SessionLiveActivity>;
  contextBySessionId?: ReadonlyMap<string, SessionContext>;
  draftBySessionId?: ReadonlyMap<string, string>;
  mutedSessionIds?: ReadonlySet<string>;
  onLongPressSession?: (id: string) => void;
  onSelectSession: (sessionId: string) => void;
  pinnedSessionIds?: ReadonlySet<string>;
  runtimeBySessionId?: ReadonlyMap<string, SessionRowRuntime>;
  selectedSessionId: string | null;
  selection: ReadonlySet<string>;
  selectionMode: boolean;
};

/**
 * One session row with its checkbox and divider. A plain function, not a
 * component: `SessionGroupSection` is called directly in tests, and the
 * virtualized list renders the same rows one item at a time.
 */
function renderSessionListRow(
  session: SessionSummary,
  isLastInGroup: boolean,
  {
    actorGlyphById,
    activityBySessionId,
    contextBySessionId,
    draftBySessionId,
    mutedSessionIds,
    onLongPressSession,
    onSelectSession,
    pinnedSessionIds,
    runtimeBySessionId,
    selectedSessionId,
    selection,
    selectionMode,
  }: SessionListRowProps,
) {
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
            context={contextBySessionId?.get(session.sessionId) ?? null}
            draft={draftBySessionId?.get(session.sessionId) ?? null}
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
      {!isLastInGroup ? (
        <Hairline style={styles.rowDivider} />
      ) : null}
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
  contextBySessionId,
  searchMessageContent,
}: SessionsListScreenProps) {
  const { t } = useTranslation();
  const draftBySessionId = useSyncExternalStore(
    subscribeComposerDrafts,
    getComposerDraftsSnapshot,
    getComposerDraftsSnapshot,
  );
  useEffect(() => {
    void hydrateComposerDrafts();
  }, []);
  const hasRows = state.groups.some((group) => group.sessions.length > 0);
  useEffect(() => {
    if (!hasRows) return;
    markChatMetric("app.cold_start", "", "list_rows");
    endChatMetric("app.cold_start");
  }, [hasRows]);
  const [placeholderMessage, setPlaceholderMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Message-content hits for the query, looked up after a 250ms pause.
  const [contentMatches, setContentMatches] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const trimmed = query.trim();
    if (!searchMessageContent || trimmed.length < MESSAGE_SEARCH_MIN_LENGTH) {
      setContentMatches(new Set());
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchMessageContent(trimmed)
        .then((ids) => {
          if (!cancelled) setContentMatches(ids);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, searchMessageContent]);
  // iOS #1603: the search keyboard goes away on scroll and on any tap outside
  // the search box (row taps still go through), and when a session opens.
  const searchInputRef = useRef<TextInput>(null);
  const dismissSearchKeyboard = useCallback(() => {
    searchInputRef.current?.blur();
    Keyboard.dismiss();
  }, []);
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
      // Seven entries: an Android alert showed three of them.
      showActionSheet(
        actions.map((a) => ({
          label: a.label,
          style: a.destructive ? ("destructive" as const) : ("default" as const),
          run: a.run,
        })),
        { cancelLabel: t("Cancel") },
      );
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
              sessions: group.sessions.filter(
                (session) =>
                  contentMatches.has(session.sessionId) ||
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
  }, [state.groups, query, pinnedSessionIds, contentMatches]);

  // Virtualized: group labels and rows are one flat list, so only the rows on
  // screen render. A ScrollView drew all of them before the first frame.
  const listItems = useMemo<SessionListItem[]>(() => {
    const out: SessionListItem[] = [];
    for (const group of filteredGroups) {
      out.push({ kind: "header", key: `header:${group.label}`, label: group.label });
      group.sessions.forEach((session, index) => {
        out.push({
          kind: "row",
          key: session.sessionId,
          session,
          isLastInGroup: index === group.sessions.length - 1,
        });
      });
    }
    return out;
  }, [filteredGroups]);

  const rowProps: SessionListRowProps = {
    actorGlyphById,
    activityBySessionId,
    contextBySessionId,
    draftBySessionId,
    mutedSessionIds,
    onLongPressSession: (id) => {
      if (selectionMode) {
        toggleSelection(id);
      } else {
        showRowContextMenu(id);
      }
    },
    onSelectSession: (id) => {
      if (selectionMode) {
        toggleSelection(id);
      } else {
        dismissSearchKeyboard();
        onSelectSession(id);
      }
    },
    pinnedSessionIds,
    runtimeBySessionId,
    selectedSessionId: selectedSessionId ?? null,
    selection,
    selectionMode,
  };

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

  // The skeleton only for a wait that is actually felt. Launch paints from the
  // local cache about a quarter-second in, and a skeleton flashed for that
  // gap read as the app loading twice; it now shows only after
  // SKELETON_DELAY_MS with nothing to draw (first sign-in, no cache).
  const isWaitingForRows =
    state.status === "loading" || (state.status === "idle" && state.sessions.length === 0);
  const [skeletonDue, setSkeletonDue] = useState(false);
  useEffect(() => {
    if (!isWaitingForRows) {
      setSkeletonDue(false);
      return;
    }
    const timer = setTimeout(() => setSkeletonDue(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isWaitingForRows]);

  const headerBar = (
    <HeaderBar
      onNewSession={handleNewSession}
      onShortcuts={handleShortcuts}
    />
  );

  if (isWaitingForRows) {
    return (
      <View style={styles.screen}>
        {headerBar}
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]}
          refreshControl={
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={state.isRefreshing}
              tintColor={colors.slate}
            />
          }
          style={styles.scroll}
        >
          {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
          {skeletonDue ? (
            <View>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  if (state.status === "error" && state.sessions.length === 0) {
    return (
      <View style={styles.screen}>
        {headerBar}
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]} style={styles.scroll}>
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
      </View>
    );
  }

  return (
    <View style={styles.screen}>
    <View onTouchStart={dismissSearchKeyboard}>{headerBar}</View>
    <FlashList
      contentContainerStyle={{ paddingBottom: bottomInset + spacing.xxxl }}
      data={listItems}
      extraData={rowProps}
      getItemType={(item) => item.kind}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={
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
      }
      ListHeaderComponent={
        <View style={styles.listHeader}>
          {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}

          {state.status === "error" && state.errorMessage ? (
            <AppCard compact style={styles.banner}>
              <Text style={styles.bannerText}>{state.errorMessage}</Text>
            </AppCard>
          ) : null}

          <View style={styles.searchField}>
            <Ionicons color={colors.slate} name="search" size={16} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
              placeholder={t("Search sessions")}
              ref={searchInputRef}
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
        </View>
      }
      onScrollBeginDrag={dismissSearchKeyboard}
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={state.isRefreshing}
          tintColor={colors.slate}
        />
      }
      renderItem={({ item }) =>
        item.kind === "header" ? (
          <SectionEyebrow label={t(item.label)} style={styles.listGroupLabel} />
        ) : (
          <View onTouchStart={dismissSearchKeyboard}>
            {renderSessionListRow(item.session, item.isLastInGroup, rowProps)}
          </View>
        )
      }
      style={{ flex: 1 }}
    />

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
    // The header sits above the scroll view, fixed; this is the gap it used to
    // put between itself and the first scrolled row.
    paddingTop: spacing.lg,
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
  listHeader: {
    gap: spacing.lg,
    paddingTop: spacing.lg,
  },
  // A group label in the flat list: the space the group gap and the label's
  // own gap used to give it.
  listGroupLabel: {
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
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
  scroll: {
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
