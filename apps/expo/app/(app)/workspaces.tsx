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
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { createWorkspacesCache } from "../../src/lib/db/team-cache";
import { showToast } from "../../src/ui/Toast";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";
import { cloudAccessToken } from "../../src/lib/cloud-api/client";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";

type WorkspaceRow = {
  id: string;
  name: string;
  path: string | null;
  agent_id: string | null;
  archived: boolean;
};

type AgentChoice = { actorId: string; displayName: string };

// Module-scoped: one cache handle for the app, not one per render.
const workspacesCache = createWorkspacesCache();

export default function WorkspacesRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const memberActorId = state.currentMemberActorId;
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const workspacesApi = useMemo(
    () => createWorkspacesApi({ getAccessToken: cloudAccessToken(cloudAuth) }),
    [],
  );

  const load = useCallback(async () => {
    if (!teamId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    // Paint last-known workspaces first, as iOS does from SwiftData.
    const cached = await workspacesCache.load(teamId);
    if (cached) {
      setRows(
        cached
          .map((w) => ({ id: w.id, name: w.name, path: w.path, agent_id: w.agentId, archived: w.archived }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setIsLoading(false);
    }
    try {
      const items = await workspacesApi.list(teamId);
      setRows(
        items
          .map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            agent_id: w.agentId,
            archived: w.archived,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      void workspacesCache.save(
        teamId,
        items.map((w) => ({
          id: w.id,
          teamId,
          name: w.name,
          path: w.path,
          agentId: w.agentId,
          archived: w.archived,
        })),
      );
    } catch (err) {
      // Keep whatever the cache painted rather than blanking the list; the
      // error line says the refresh failed.
      setError(err instanceof Error ? err.message : t("Couldn't load workspaces."));
      if (!cached) setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, [teamId, workspacesApi]);

  useEffect(() => {
    let cancelled = false;
    void load().catch(() => {
      // load already surfaces errors
    });
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, [load]);

  const handleArchive = async (id: string, archived: boolean) => {
    try {
      await workspacesApi.setArchived(id, archived);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't update workspace."));
    }
  };

  const [editingPathId, setEditingPathId] = useState<string | null>(null);
  const [editPathDraft, setEditPathDraft] = useState("");
  const [agents, setAgents] = useState<AgentChoice[]>([]);
  const [pickingAgentFor, setPickingAgentFor] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: cloudAccessToken(cloudAuth) })
      .listActors(teamId)
      .then((rows) => {
        if (cancelled) return;
        setAgents(
          rows
            .filter((row) => row.actorType === "agent")
            .map((row) => ({ actorId: row.actorId, displayName: row.displayName })),
        );
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const handleAgentBind = async (workspaceId: string, agentId: string | null) => {
    try {
      await workspacesApi.bindAgent(workspaceId, agentId);
      setRows((prev) =>
        prev.map((row) =>
          row.id === workspaceId ? { ...row, agent_id: agentId } : row,
        ),
      );
      setPickingAgentFor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't bind agent."));
    }
  };

  const commitPath = async (id: string) => {
    try {
      const next = editPathDraft.trim();
      await workspacesApi.setPath(id, next || null);
      setRows((prev) => prev.map((row) => (row.id === id ? { ...row, path: next || null } : row)));
      setEditingPathId(null);
      setEditPathDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't update path."));
    }
  };

  const handleCreate = async () => {
    if (!teamId || !memberActorId) return;
    const name = createDraft.trim();
    if (!name) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await workspacesApi.create({
        teamId,
        name,
        createdByMemberId: memberActorId,
      });
      setCreateDraft("");
      showToast("success", t("Workspace created"));
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("Couldn't create workspace."));
    } finally {
      setIsCreating(false);
    }
  };

  const active = rows.filter((row) => !row.archived);
  const archived = rows.filter((row) => row.archived);

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Workspaces")}</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              void load();
            }}
            refreshing={isLoading && rows.length > 0}
            tintColor={colors.slate}
          />
        }
      >
        <View style={styles.section}>
          <SectionEyebrow label={t("NEW WORKSPACE")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <View style={styles.createRow}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isCreating}
                onChangeText={setCreateDraft}
                placeholder={t("workspace-name")}
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.createInput}
                value={createDraft}
              />
              <Pressable
                accessibilityRole="button"
                disabled={isCreating || createDraft.trim().length === 0 || !memberActorId}
                onPress={handleCreate}
                style={({ pressed }) => [
                  styles.createButton,
                  createDraft.trim().length > 0 && !isCreating
                    ? styles.createButtonActive
                    : styles.createButtonIdle,
                  pressed && createDraft.trim().length > 0 ? styles.createButtonPressed : null,
                ]}
              >
                <Text
                  style={[
                    styles.createButtonText,
                    createDraft.trim().length > 0 && !isCreating
                      ? styles.createButtonTextActive
                      : styles.createButtonTextIdle,
                  ]}
                >
                  {isCreating ? t("Creating…") : t("Create")}
                </Text>
              </Pressable>
            </View>
          </View>
          {createError ? <Text style={styles.errorText}>{createError}</Text> : null}
        </View>

        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>{t("Loading workspaces…")}</Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("Couldn't load workspaces")}</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("No workspaces")}</Text>
            <Text style={styles.body}>
              {t("Workspaces show up here once an agent connects to one.")}
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            <View style={styles.section}>
              <SectionEyebrow
                label={`${t("ACTIVE")} · ${active.length}`}
                style={styles.sectionEyebrow}
              />
              <View style={styles.card}>
                {active.map((row, index) => {
                  const isEditingPath = editingPathId === row.id;
                  return (
                    <View key={row.id}>
                      <View style={styles.row}>
                        <View style={styles.rowBody}>
                          <Text style={styles.rowLabel}>{row.name || row.id}</Text>
                          {isEditingPath ? (
                            <TextInput
                              autoCapitalize="none"
                              autoCorrect={false}
                              autoFocus
                              onBlur={() => void commitPath(row.id)}
                              onChangeText={setEditPathDraft}
                              onSubmitEditing={() => void commitPath(row.id)}
                              placeholder={t("~/code/repo")}
                              placeholderTextColor={colors.slate}
                              returnKeyType="done"
                              selectionColor={colors.cinnabar}
                              style={styles.pathInput}
                              value={editPathDraft}
                            />
                          ) : (
                            <Pressable
                              accessibilityLabel="Edit workspace path"
                              accessibilityRole="button"
                              onPress={() => {
                                setEditingPathId(row.id);
                                setEditPathDraft(row.path ?? "");
                              }}
                            >
                              <Text style={styles.rowPath}>
                                {row.path && row.path.length > 0
                                  ? row.path
                                  : t("Set local path…")}
                              </Text>
                            </Pressable>
                          )}
                        </View>
                        <Pressable
                          accessibilityLabel={`Archive ${row.name}`}
                          accessibilityRole="button"
                          hitSlop={6}
                          onPress={() => handleArchive(row.id, true)}
                        >
                          <Ionicons color={colors.slate} name="archive-outline" size={18} />
                        </Pressable>
                      </View>
                      {pickingAgentFor === row.id ? (
                        <View style={styles.agentPickerRow}>
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => handleAgentBind(row.id, null)}
                            style={[
                              styles.agentChip,
                              !row.agent_id ? styles.agentChipSelected : null,
                            ]}
                          >
                            <Text
                              style={[
                                styles.agentChipText,
                                !row.agent_id ? styles.agentChipTextSelected : null,
                              ]}
                            >
                              {t("None")}
                            </Text>
                          </Pressable>
                          {agents.map((agent) => {
                            const selected = row.agent_id === agent.actorId;
                            return (
                              <Pressable
                                accessibilityRole="button"
                                key={agent.actorId}
                                onPress={() => handleAgentBind(row.id, agent.actorId)}
                                style={[
                                  styles.agentChip,
                                  selected ? styles.agentChipSelected : null,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.agentChipText,
                                    selected ? styles.agentChipTextSelected : null,
                                  ]}
                                >
                                  {agent.displayName}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      ) : (
                        <Pressable
                          accessibilityRole="button"
                          hitSlop={4}
                          onPress={() => setPickingAgentFor(row.id)}
                          style={styles.agentBindHint}
                        >
                          <Ionicons
                            color={row.agent_id ? colors.cinnabar : colors.slate}
                            name="sparkles-outline"
                            size={12}
                          />
                          <Text style={styles.agentBindText}>
                            {row.agent_id
                              ? agents.find((a) => a.actorId === row.agent_id)?.displayName ??
                                t("Bound agent")
                              : t("Bind an agent")}
                          </Text>
                        </Pressable>
                      )}
                      {index < active.length - 1 ? <Hairline /> : null}
                    </View>
                  );
                })}
              </View>
            </View>
            {archived.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`${t("ARCHIVED")} · ${archived.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {archived.map((row, index) => (
                    <View key={row.id}>
                      <View style={styles.row}>
                        <Text style={styles.rowLabelArchived}>{row.name || row.id}</Text>
                        <View style={{ flex: 1 }} />
                        <Pressable
                          accessibilityLabel={`Restore ${row.name}`}
                          accessibilityRole="button"
                          hitSlop={6}
                          onPress={() => handleArchive(row.id, false)}
                        >
                          <Ionicons
                            color={colors.cinnabar}
                            name="arrow-undo-outline"
                            size={18}
                          />
                        </Pressable>
                      </View>
                      {index < archived.length - 1 ? <Hairline /> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  createButton: {
    alignItems: "center",
    borderRadius: radii.button,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  createButtonActive: {
    backgroundColor: hai.cinnabar,
  },
  createButtonIdle: {
    backgroundColor: hai.pebble,
  },
  createButtonPressed: {
    opacity: 0.88,
  },
  createButtonText: {
    ...typography.caption,
    fontWeight: "700",
  },
  createButtonTextActive: {
    color: hai.paper,
  },
  createButtonTextIdle: {
    color: hai.slate,
  },
  createInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  createRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
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
  groups: {
    gap: spacing.lg,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  agentBindHint: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  agentBindText: {
    color: colors.slate,
    ...typography.caption,
  },
  agentChip: {
    backgroundColor: hai.pebble,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  agentChipSelected: {
    backgroundColor: hai.cinnabar,
  },
  agentChipText: {
    color: hai.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  agentChipTextSelected: {
    color: hai.paper,
  },
  agentPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  pathInput: {
    color: colors.basalt,
    padding: 0,
    ...typography.monoMeta,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
  },
  rowPath: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  rowLabelArchived: {
    color: colors.slate,
    ...typography.body,
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
  stateBlock: {
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});
