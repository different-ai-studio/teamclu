import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
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

import { matchesAnyField } from "../../search/search-matcher";
import { SkeletonRow } from "../../../ui/atoms/SkeletonRow";


import {
  SegmentedFilter,
  type SegmentedFilterSegment,
} from "../../actors/components/SegmentedFilter";
import { Hairline } from "../../../ui/atoms/Hairline";
import { PrimaryButton } from "../../../ui/button";
import { PageHeader } from "../../../ui/PageHeader";
import { SwipeableRow } from "../../../ui/SwipeableRow";
import { impactLight, selectionTick } from "../../../lib/haptics";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { IdeaRow } from "../components/IdeaRow";
import {
  isDoneIdea,
  isMineIdea,
  isOpenIdea,
  type IdeasListState,
} from "../idea-types";

type Filter = "all" | "mine" | "open" | "done";

export type IdeasListScreenProps = {
  /** Extra bottom inset so content clears the floating tab bar. */
  bottomInset?: number;
  actorNames?: ReadonlyMap<string, string>;
  currentActorId: string | null;
  onArchiveBatch?: (ideaIds: string[]) => Promise<void>;
  onCreate?: () => void;
  onLoad: () => void;
  onOpenArchived?: () => void;
  onOpenStats?: () => void;
  onRefresh: () => void;
  /** Move `ideaId` to `destinationIndex` in the team's stored idea order. */
  onReorder?: (ideaId: string, destinationIndex: number) => void;
  onSelectIdea?: (ideaId: string) => void;
  /** Like/unlike from the feed card's heart; `liked` is the desired state. */
  onToggleLike?: (ideaId: string, liked: boolean) => void;
  state: IdeasListState;
};

function HeaderBar({
  count,
  onCreate,
  onOpenArchived,
  onOpenStats,
}: {
  count: number;
  onCreate?: () => void;
  onOpenArchived?: () => void;
  onOpenStats?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PageHeader
      count={count}
      right={
        <View style={styles.toolbarGroup}>
          {onOpenStats ? (
            <Pressable
              accessibilityLabel={t("Idea statistics")}
              accessibilityRole="button"
              hitSlop={8}
              onPress={onOpenStats}
              style={styles.toolbarButton}
            >
              <Ionicons color={colors.onyx} name="stats-chart-outline" size={20} />
            </Pressable>
          ) : null}
          {onOpenArchived ? (
            <Pressable
              accessibilityLabel={t("Archived ideas")}
              accessibilityRole="button"
              hitSlop={8}
              onPress={onOpenArchived}
              style={styles.toolbarButton}
            >
              <Ionicons color={colors.onyx} name="archive-outline" size={22} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel={t("Create Idea")}
            accessibilityRole="button"
            disabled={!onCreate}
            hitSlop={8}
            onPress={onCreate}
            style={styles.toolbarButton}
          >
            <Ionicons
              color={onCreate ? colors.onyx : colors.slate}
              name="add"
              size={26}
            />
          </Pressable>
        </View>
      }
      title={t("Ideas")}
    />
  );
}

export function IdeasListScreen({
  bottomInset = 0,
  actorNames,
  currentActorId,
  onArchiveBatch,
  onCreate,
  onLoad,
  onOpenArchived,
  onOpenStats,
  onRefresh,
  onReorder,
  onSelectIdea,
  onToggleLike,
  state,
}: IdeasListScreenProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const selectionMode = selection.size > 0;

  const workspaceOptions = useMemo(() => {
    const names = new Set<string>();
    for (const idea of state.ideas) {
      if (idea.workspaceName) names.add(idea.workspaceName);
    }
    return [...names].sort();
  }, [state.ideas]);

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

  /** A search or filter hides rows, so "position N" would no longer match the
   * stored order the reorder endpoint writes. Reordering is offered only on the
   * full list. */
  const isFiltered = filter !== "all" || query.trim().length > 0 || workspaceFilter !== null;

  const showRowContextMenu = useCallback(
    (ideaId: string) => {
      impactLight();
      // Reorder entries stand in for the drag handle iOS gets from
      // `List.onMove`; they call the same reorder endpoint underneath. Only
      // offered on the unfiltered list, where the visible order is the stored
      // order and a "position" is meaningful.
      const canReorder = Boolean(onReorder) && !isFiltered;
      const position = state.ideas.findIndex((idea) => idea.ideaId === ideaId);
      const canMoveUp = canReorder && position > 0;
      const canMoveDown = canReorder && position >= 0 && position < state.ideas.length - 1;

      type Entry = { label: string; destructive?: boolean; run: () => void };
      const entries: Entry[] = [
        {
          label: t("Archive"),
          destructive: true,
          run: () => {
            if (onArchiveBatch) void onArchiveBatch([ideaId]);
          },
        },
        { label: t("Select more…"), run: () => toggleSelection(ideaId) },
      ];
      if (canMoveUp) {
        entries.push({ label: t("Move up"), run: () => onReorder?.(ideaId, position - 1) });
        entries.push({ label: t("Move to top"), run: () => onReorder?.(ideaId, 0) });
      }
      if (canMoveDown) {
        entries.push({ label: t("Move down"), run: () => onReorder?.(ideaId, position + 1) });
        entries.push({
          label: t("Move to bottom"),
          run: () => onReorder?.(ideaId, state.ideas.length - 1),
        });
      }

      const labels = [...entries.map((entry) => entry.label), t("Cancel")];
      const dispatch = (index: number) => {
        entries[index]?.run();
      };
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: labels,
            cancelButtonIndex: entries.length,
            destructiveButtonIndex: 0,
          },
          dispatch,
        );
        return;
      }
      Alert.alert(t("Idea actions"), undefined, [
        ...entries.map((entry, index) => ({
          text: entry.label,
          style: entry.destructive ? ("destructive" as const) : undefined,
          onPress: () => dispatch(index),
        })),
        { text: t("Cancel"), style: "cancel" as const },
      ]);
    },
    [isFiltered, onArchiveBatch, onReorder, state.ideas, t],
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

  const searched = useMemo(() => {
    const queryFiltered =
      query.trim().length === 0
        ? state.ideas
        : state.ideas.filter((idea) =>
            matchesAnyField([idea.title, idea.description, idea.workspaceName], query),
          );
    if (!workspaceFilter) return queryFiltered;
    return queryFiltered.filter((idea) => idea.workspaceName === workspaceFilter);
  }, [state.ideas, query, workspaceFilter]);

  const counts = useMemo(() => {
    let mine = 0;
    let open = 0;
    let done = 0;
    for (const idea of searched) {
      if (isMineIdea(idea, currentActorId)) mine += 1;
      if (isOpenIdea(idea)) open += 1;
      if (isDoneIdea(idea)) done += 1;
    }
    return { mine, open, done };
  }, [searched, currentActorId]);

  const segments: SegmentedFilterSegment<Filter>[] = [
    { tag: "all", title: t("All"), count: searched.length },
    ...(currentActorId
      ? [{ tag: "mine" as const, title: t("Mine"), count: counts.mine }]
      : []),
    { tag: "open", title: t("Open"), count: counts.open },
    { tag: "done", title: t("Done"), count: counts.done },
  ];

  const filteredIdeas = searched.filter((idea) => {
    if (filter === "all") return true;
    if (filter === "mine") return isMineIdea(idea, currentActorId);
    if (filter === "open") return isOpenIdea(idea);
    if (filter === "done") return isDoneIdea(idea);
    return true;
  });

  const headerBar = (
    <HeaderBar
      count={state.ideas.length}
      onCreate={onCreate}
      onOpenArchived={onOpenArchived}
      onOpenStats={onOpenStats}
    />
  );

  if (state.status === "loading" || (state.status === "idle" && state.ideas.length === 0)) {
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
        <View>
          <SkeletonRow avatar={false} />
          <SkeletonRow avatar={false} />
          <SkeletonRow avatar={false} />
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.ideas.length === 0) {
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]} style={styles.screen}>
        {headerBar}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>{t("Couldn't load ideas")}</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? t("Try again in a moment.")}</Text>
          <PrimaryButton fullWidth={false} label={t("Retry")} onPress={onLoad} />
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

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t("Search ideas")}
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

      <SegmentedFilter onSelect={setFilter} segments={segments} selection={filter} />

      {workspaceOptions.length > 0 ? (
        <View style={styles.workspaceRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setWorkspaceFilter(null)}
            style={[
              styles.workspaceChip,
              !workspaceFilter ? styles.workspaceChipSelected : null,
            ]}
          >
            <Text
              style={[
                styles.workspaceChipText,
                !workspaceFilter ? styles.workspaceChipTextSelected : null,
              ]}
            >
              {t("All workspaces")}
            </Text>
          </Pressable>
          {workspaceOptions.map((name) => {
            const selected = workspaceFilter === name;
            return (
              <Pressable
                accessibilityRole="button"
                key={name}
                onPress={() => setWorkspaceFilter(name)}
                style={[
                  styles.workspaceChip,
                  selected ? styles.workspaceChipSelected : null,
                ]}
              >
                <Text
                  style={[
                    styles.workspaceChipText,
                    selected ? styles.workspaceChipTextSelected : null,
                  ]}
                >
                  {name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {state.ideas.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>{t("No Ideas")}</Text>
          <Text style={styles.stateBody}>{t("Tap + to create an idea.")}</Text>
        </View>
      ) : filteredIdeas.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.emptyFilterTitle}>
            {filter === "mine"
              ? t("Nothing here yet")
              : filter === "open"
              ? t("No open ideas")
              : filter === "done"
              ? t("No completed ideas")
              : t("No ideas")}
          </Text>
          <Text style={styles.emptyFilterBody}>
            {filter === "mine"
              ? t("Ideas you create will show up here.")
              : filter === "open"
              ? t("Open ideas will appear once created.")
              : filter === "done"
              ? t("Mark an idea as Done to see it here.")
              : t("Tap + to create an idea.")}
          </Text>
        </View>
      ) : (
        <View>
          {filteredIdeas.map((idea, index) => {
            const checked = selection.has(idea.ideaId);
            return (
              <View key={idea.ideaId}>
                <SwipeableRow
                  enabled={!selectionMode && !!onArchiveBatch}
                  trailingActions={
                    onArchiveBatch
                      ? [
                          {
                            label: t("Archive"),
                            iconName: "archive-outline",
                            destructive: true,
                            onPress: () => {
                              void onArchiveBatch([idea.ideaId]);
                            },
                          },
                        ]
                      : []
                  }
                >
                  <Pressable
                    onLongPress={() => {
                      if (selectionMode) {
                        toggleSelection(idea.ideaId);
                      } else {
                        showRowContextMenu(idea.ideaId);
                      }
                    }}
                    onPress={() => {
                      if (selectionMode) {
                        toggleSelection(idea.ideaId);
                      } else if (onSelectIdea) {
                        onSelectIdea(idea.ideaId);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.ideaRowOuter,
                      checked ? styles.ideaRowChecked : null,
                      pressed ? styles.ideaRowPressed : null,
                    ]}
                  >
                    {selectionMode ? (
                      <View style={[styles.checkbox, checked ? styles.checkboxOn : null]}>
                        {checked ? (
                          <Ionicons color="#F8F6F1" name="checkmark" size={14} />
                        ) : null}
                      </View>
                    ) : null}
                    <View style={styles.ideaRowBody}>
                      <IdeaRow
                        creatorId={idea.createdByActorId}
                        creatorName={
                          idea.createdByActorId
                            ? actorNames?.get(idea.createdByActorId) ?? null
                            : null
                        }
                        feed
                        idea={idea}
                        onOpenComments={
                          !selectionMode && onSelectIdea
                            ? () => onSelectIdea(idea.ideaId)
                            : undefined
                        }
                        onToggleLike={
                          !selectionMode && onToggleLike
                            ? (liked) => onToggleLike(idea.ideaId, liked)
                            : undefined
                        }
                      />
                    </View>
                  </Pressable>
                </SwipeableRow>
                {index < filteredIdeas.length - 1 ? (
                  <Hairline style={styles.rowDivider} />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      </ScrollView>

      {selectionMode ? (
        <View style={styles.batchBar}>
          <Text style={styles.batchCount}>{t("{{count}} selected", { count: selection.size })}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={clearSelection}
            style={({ pressed }) => [
              styles.batchAction,
              pressed ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>{t("Cancel")}</Text>
          </Pressable>
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
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  emptyFilterBody: {
    color: colors.slate,
    ...typography.caption,
  },
  emptyFilterTitle: {
    color: colors.basalt,
    ...typography.secondaryBody,
    fontWeight: "600",
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowDivider: {
    marginHorizontal: spacing.lg,
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
    borderRadius: radii.button,
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
    width: 22,
  },
  checkboxOn: {
    backgroundColor: colors.cinnabar,
    borderColor: colors.cinnabar,
  },
  ideaRowBody: {
    flex: 1,
  },
  ideaRowChecked: {
    backgroundColor: "rgba(184,75,54,0.06)",
  },
  ideaRowOuter: {
    alignItems: "center",
    flexDirection: "row",
    paddingLeft: spacing.lg,
  },
  ideaRowPressed: {
    opacity: 0.88,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  workspaceChip: {
    backgroundColor: colors.pebble,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  workspaceChipSelected: {
    backgroundColor: colors.basalt,
  },
  workspaceChipText: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  workspaceChipTextSelected: {
    color: colors.paper,
  },
  workspaceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
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
  toolbarGroup: {
    flexDirection: "row",
  },
});

export default IdeasListScreen;
