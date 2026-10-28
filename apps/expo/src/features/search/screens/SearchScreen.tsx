import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ActorRow } from "../../actors/components/ActorRow";
import {
  isMemberActor,
  type Actor,
} from "../../actors/actor-types";
import { IdeaRow } from "../../ideas/components/IdeaRow";
import type { Idea } from "../../ideas/idea-types";
import { SessionRow } from "../../sessions/components/SessionRow";
import type { SessionSummary } from "../../sessions/session-types";
import { Hairline } from "../../../ui/atoms/Hairline";
import { HeaderBackButton } from "../../../ui/HeaderBackButton";
import { PageHeader } from "../../../ui/PageHeader";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import {
  clearSearchHistory,
  loadSearchHistory,
  recordSearchQuery,
} from "../search-history";
import { matchesAnyField, matchesQuery } from "../search-matcher";

export type SearchScreenProps = {
  /** Extra bottom inset for anything floating over the list. */
  bottomInset?: number;
  /** Shown as a back chevron: the screen is pushed from the session home menu. */
  onBack?: () => void;
  actors: Actor[];
  ideas: Idea[];
  isLoading: boolean;
  onSelectActor?: (actorId: string) => void;
  onSelectIdea?: (ideaId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  sessions: SessionSummary[];
};

function HeaderBar({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  return (
    <PageHeader
      left={onBack ? <HeaderBackButton onPress={onBack} /> : undefined}
      title={t("Search")}
    />
  );
}

export function SearchScreen({
  bottomInset = 0,
  onBack,
  actors,
  ideas,
  isLoading,
  onSelectActor,
  onSelectIdea,
  onSelectSession,
  sessions,
}: SearchScreenProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), 80);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void loadSearchHistory().then((rows) => {
      if (!cancelled) setHistory(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) return;
    const timeout = setTimeout(() => {
      void recordSearchQuery(trimmed).then((next) => setHistory(next));
    }, 800);
    return () => clearTimeout(timeout);
  }, [debouncedQuery]);

  const trimmed = debouncedQuery.trim();

  const sessionMatches = useMemo(() => {
    if (!trimmed) return [];
    return sessions.filter((session) =>
      matchesAnyField([session.title, session.summary, session.lastMessagePreview], trimmed),
    );
  }, [sessions, trimmed]);

  const ideaMatches = useMemo(() => {
    if (!trimmed) return [];
    return ideas.filter((idea) =>
      matchesAnyField([idea.title, idea.description, idea.workspaceName], trimmed),
    );
  }, [ideas, trimmed]);

  const memberMatches = useMemo(() => {
    if (!trimmed) return [];
    return actors.filter(isMemberActor).filter((actor) => matchesQuery(actor.displayName, trimmed));
  }, [actors, trimmed]);

  const anyResults =
    sessionMatches.length + ideaMatches.length + memberMatches.length > 0;

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xxxl }]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
    >
      <HeaderBar onBack={onBack} />

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t("Search sessions, ideas, and members")}
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel={t("Clear search")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setQuery("")}
          >
            <Ionicons color={colors.slate} name="close-circle" size={16} />
          </Pressable>
        ) : null}
      </View>

      {trimmed.length === 0 ? (
        <View style={styles.stateBlock}>
          {isLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.slate} />
              <Text style={styles.stateBody}>{t("Loading team data…")}</Text>
            </View>
          ) : history.length > 0 ? (
            <>
              <View style={styles.historyHeader}>
                <SectionEyebrow label={t("RECENT · {{count}}", { count: history.length })} />
                <Pressable
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => {
                    void clearSearchHistory().then(() => setHistory([]));
                  }}
                >
                  <Text style={styles.historyClear}>{t("Clear")}</Text>
                </Pressable>
              </View>
              <View style={styles.historyList}>
                {history.map((entry) => (
                  <Pressable
                    accessibilityRole="button"
                    key={entry}
                    onPress={() => setQuery(entry)}
                    style={({ pressed }) => [
                      styles.historyChip,
                      pressed ? styles.historyChipPressed : null,
                    ]}
                  >
                    <Ionicons color={colors.slate} name="time-outline" size={12} />
                    <Text numberOfLines={1} style={styles.historyChipText}>
                      {entry}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              <Text style={styles.stateTitle}>{t("Search")}</Text>
              <Text style={styles.stateBody}>
                {t("Search sessions, ideas, and members.")}
              </Text>
            </>
          )}
        </View>
      ) : !anyResults ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>{t("No results")}</Text>
          <Text style={styles.stateBody}>
            {t("Nothing matched \u201c{{value}}\u201d. Try different words.", { value: trimmed })}
          </Text>
        </View>
      ) : (
        <View style={styles.groups}>
          {sessionMatches.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow
                label={t("Sessions · {{count}}", { count: sessionMatches.length })}
                style={styles.sectionLabel}
              />
              <View>
                {sessionMatches.map((session, index) => (
                  <View key={session.sessionId}>
                    <SessionRow
                      onPress={() => onSelectSession?.(session.sessionId)}
                      session={session}
                    />
                    {index < sessionMatches.length - 1 ? (
                      <Hairline style={styles.rowDivider} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {ideaMatches.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow
                label={t("Ideas · {{count}}", { count: ideaMatches.length })}
                style={styles.sectionLabel}
              />
              <View>
                {ideaMatches.map((idea, index) => (
                  <View key={idea.ideaId}>
                    <Pressable onPress={() => onSelectIdea?.(idea.ideaId)}>
                      <IdeaRow idea={idea} />
                    </Pressable>
                    {index < ideaMatches.length - 1 ? (
                      <Hairline style={styles.rowDivider} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {memberMatches.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow
                label={t("Members · {{count}}", { count: memberMatches.length })}
                style={styles.sectionLabel}
              />
              <View>
                {memberMatches.map((actor, index) => (
                  <View key={actor.actorId}>
                    <Pressable onPress={() => onSelectActor?.(actor.actorId)}>
                      <ActorRow actor={actor} />
                    </Pressable>
                    {index < memberMatches.length - 1 ? (
                      <Hairline style={styles.rowDivider} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
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
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  historyChip: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  historyChipPressed: {
    opacity: 0.7,
  },
  historyChipText: {
    color: colors.onyx,
    ...typography.caption,
  },
  historyClear: {
    color: colors.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  historyHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  historyList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
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
});

export default SearchScreen;
