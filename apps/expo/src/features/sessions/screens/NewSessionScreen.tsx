import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { isAgentActor, type Actor } from "../../actors/actor-types";
import { teamAppNeedsDesktopSetup, type TeamApp } from "../../apps/team-app-types";
import { orderActorsForPicker, type LastContactByActor } from "../actor-picker-ordering";
import {
  appCheckoutWorkspace,
  appSessionBlocker,
  type AppSessionBlocker,
} from "../app-session";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import type { AgentConfigSelection } from "../components/AgentConfigSheet";
import {
  agentConfigWorkspaceChoices,
  normalizeStoredAgentType,
} from "../components/agent-config-helpers";
import { MemberPickerSheet } from "./MemberPickerSheet";
import { SheetModal } from "../../../ui/SheetModal";

export type AgentWorkspaceChoice = {
  id: string;
  path: string;
  agentId?: string | null;
};

export type NewSessionScreenProps = {
  actors?: ReadonlyArray<Actor>;
  /**
   * The team's apps for the app picker (iOS #1602, replacing the idea
   * picker). `null` — the apps feature is off — hides the section.
   */
  apps?: ReadonlyArray<TeamApp> | null;
  currentMemberActorId?: string | null;
  /** The viewer's effective default agent, pinned first in the picker. */
  defaultAgentId?: string | null;
  errorMessage?: string | null;
  isBusy?: boolean;
  /** When each actor last sent a message, for the picker's recent-contact order. */
  lastContactByActorId?: LastContactByActor;
  /**
   * One agent's own workspaces, fetched once an app is picked: the team-wide
   * list is a single capped page and can miss the app's checkout row.
   */
  loadAgentWorkspaces?: (agentId: string) => Promise<AgentWorkspaceChoice[]>;
  onClose: () => void;
  onCreate: (payload: {
    firstMessage: string;
    collaboratorActorIds: string[];
    primaryAgentActorId: string | null;
    agentConfig: AgentConfigSelection | null;
    /** The idea the sheet was opened from; there is no idea picker any more. */
    ideaId: string | null;
    app: TeamApp | null;
    /** Every workspace row seen for the picked agents, for resolving checkouts. */
    agentWorkspaces: AgentWorkspaceChoice[];
  }) => Promise<void> | void;
  /** Set when opened from an idea: the session is linked to it and its text prefaces the first message. */
  selectedIdeaId?: string | null;
  workspaces?: ReadonlyArray<AgentWorkspaceChoice>;
};

/** The blocker as a sentence, or null. */
function appBlockerText(
  blocker: AppSessionBlocker | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!blocker) return null;
  switch (blocker.kind) {
    case "needsAgent":
      return t("An app session needs an agent — add one to collaborate first.");
    case "checking":
      return t("Checking whether the agent's computer has this app's code…");
    case "missingCheckout":
      return t(
        "The computer {{names}} runs on doesn't have \"{{app}}\" yet — open the app in the desktop app on that computer first.",
        { names: blocker.agentNames.join("、"), app: blocker.appName },
      );
  }
}

const NO_CONTACTS: LastContactByActor = new Map();

export function NewSessionScreen({
  actors = [],
  apps = null,
  currentMemberActorId = null,
  defaultAgentId = null,
  errorMessage = null,
  isBusy = false,
  lastContactByActorId = NO_CONTACTS,
  loadAgentWorkspaces,
  onClose,
  onCreate,
  selectedIdeaId = null,
  workspaces = [],
}: NewSessionScreenProps) {
  const { t } = useTranslation();
  const [firstMessage, setFirstMessage] = useState("");
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const [primaryAgentId, setPrimaryAgentId] = useState<string | null>(null);
  const [pickedAppId, setPickedAppId] = useState<string | null>(null);
  const [agentWorkspacesForApp, setAgentWorkspacesForApp] = useState<AgentWorkspaceChoice[]>([]);
  const [isCheckingAppCheckout, setIsCheckingAppCheckout] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfigSelection | null>(null);
  /** Set once the user picks (or clears) the agent, so the default stops applying. */
  const didChooseAgent = useRef(false);

  const actorById = useMemo(() => {
    const map = new Map<string, Actor>();
    for (const actor of actors) {
      map.set(actor.actorId, actor);
    }
    return map;
  }, [actors]);

  // Everyone besides the primary agent (iOS `otherCollaborators`): people,
  // and any further agents brought in alongside it.
  const otherCollaborators = useMemo(() => {
    return collaboratorIds
      .filter((id) => id !== primaryAgentId)
      .map((id) => actorById.get(id))
      .filter((actor): actor is Actor => Boolean(actor));
  }, [collaboratorIds, actorById, primaryAgentId]);

  const primaryAgent = primaryAgentId ? actorById.get(primaryAgentId) ?? null : null;

  // Primary agent first, as the session sees it.
  const collaborators = useMemo(
    () => (primaryAgent ? [primaryAgent, ...otherCollaborators] : otherCollaborators),
    [otherCollaborators, primaryAgent],
  );

  const pickedAgentIds = useMemo(
    () => collaborators.filter(isAgentActor).map((actor) => actor.actorId),
    [collaborators],
  );

  const effectivePrimaryAgentId = primaryAgent?.actorId ?? pickedAgentIds[0] ?? null;

  // Start with the viewer's default agent (iOS `selectDefaultAgent`), unless
  // they already picked one or brought agents in some other way.
  useEffect(() => {
    if (didChooseAgent.current || primaryAgentId) return;
    if (!defaultAgentId) return;
    const agent = actorById.get(defaultAgentId);
    if (!agent || !isAgentActor(agent)) return;
    setPrimaryAgentId(defaultAgentId);
  }, [actorById, defaultAgentId, primaryAgentId]);

  const pickedApp = useMemo(
    () => (pickedAppId ? apps?.find((app) => app.id === pickedAppId) ?? null : null),
    [apps, pickedAppId],
  );

  // Once an app is picked, fetch each picked agent's own workspaces so its
  // checkout row is found even in a team past the one-page workspace list.
  const appCheckoutQueryKey = pickedApp ? [pickedApp.id, ...[...pickedAgentIds].sort()].join(",") : "";
  useEffect(() => {
    if (!appCheckoutQueryKey || !loadAgentWorkspaces) {
      setAgentWorkspacesForApp([]);
      setIsCheckingAppCheckout(false);
      return;
    }
    let cancelled = false;
    setIsCheckingAppCheckout(true);
    void Promise.all(
      pickedAgentIds.map((agentId) => loadAgentWorkspaces(agentId).catch(() => [])),
    ).then((rows) => {
      if (cancelled) return;
      setAgentWorkspacesForApp(rows.flat());
      setIsCheckingAppCheckout(false);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the app and the sorted agent ids, not on the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appCheckoutQueryKey, loadAgentWorkspaces]);

  const appWorkspaceRows = useMemo(
    () =>
      [...agentWorkspacesForApp, ...workspaces].map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        agentId: workspace.agentId ?? null,
      })),
    [agentWorkspacesForApp, workspaces],
  );

  const appBlocker = useMemo(
    () =>
      appSessionBlocker({
        app: pickedApp,
        agents: collaborators.filter(isAgentActor),
        workspaces: appWorkspaceRows,
        isChecking: isCheckingAppCheckout,
      }),
    [appWorkspaceRows, collaborators, isCheckingAppCheckout, pickedApp],
  );
  const appBlockerMessage = appBlockerText(appBlocker, t);

  // Default agent first, then by recent contact, then by name (iOS #1602).
  const pickerActors = useMemo(
    () => orderActorsForPicker(actors as Actor[], defaultAgentId, lastContactByActorId),
    [actors, defaultAgentId, lastContactByActorId],
  );

  const agentChoices = useMemo(() => pickerActors.filter(isAgentActor), [pickerActors]);

  // The primary agent's own workspaces, its default first — the seat it gets
  // when nothing is picked (iOS #1681).
  const workspaceChoices = useMemo(
    () =>
      primaryAgent
        ? agentConfigWorkspaceChoices(
            primaryAgent.actorId,
            primaryAgent.defaultWorkspaceId ?? null,
            workspaces,
          )
        : [],
    [primaryAgent, workspaces],
  );

  const workspaceRowValue = useMemo((): { text: string; muted: boolean } => {
    if (!primaryAgent) return { text: t("None"), muted: true };
    // An app session runs in the agent's checkout of the app, whatever is
    // picked here.
    if (pickedApp) {
      const checkout = appCheckoutWorkspace(pickedApp, primaryAgent.actorId, appWorkspaceRows);
      return checkout
        ? { text: checkout.path, muted: false }
        : { text: t("None"), muted: true };
    }
    const picked = agentConfig
      ? workspaceChoices.find((workspace) => workspace.id === agentConfig.workspaceId)
      : workspaceChoices[0];
    return picked
      ? { text: picked.path || picked.id, muted: false }
      : { text: t("None"), muted: true };
  }, [agentConfig, appWorkspaceRows, pickedApp, primaryAgent, t, workspaceChoices]);

  const excludedFromPicker = useMemo(() => {
    const set = new Set<string>();
    if (currentMemberActorId) set.add(currentMemberActorId);
    if (primaryAgentId) set.add(primaryAgentId);
    return set;
  }, [currentMemberActorId, primaryAgentId]);

  const selectPrimaryAgent = useCallback((agentId: string | null) => {
    didChooseAgent.current = true;
    setPrimaryAgentId(agentId);
    // The workspace belongs to the old agent; the new one starts on its default.
    setAgentConfig(null);
    if (agentId) setCollaboratorIds((prev) => prev.filter((id) => id !== agentId));
  }, []);

  const removeCollaborator = useCallback((actorId: string) => {
    setCollaboratorIds((prev) => prev.filter((id) => id !== actorId));
  }, []);

  const canSubmit =
    firstMessage.trim().length > 0 &&
    collaborators.length > 0 &&
    !isBusy &&
    appBlocker === null;

  const handleStart = () => {
    if (!canSubmit) return;
    void onCreate({
      firstMessage: firstMessage.trim(),
      collaboratorActorIds: collaborators.map((actor) => actor.actorId),
      primaryAgentActorId: effectivePrimaryAgentId,
      agentConfig,
      ideaId: selectedIdeaId,
      app: pickedApp,
      agentWorkspaces: agentWorkspacesForApp,
    });
  };

  /** One action-sheet picker for the agent and workspace rows, as the app row already does. */
  const showChoices = (
    title: string,
    labels: string[],
    onPick: (index: number) => void,
  ) => {
    const options = [...labels, t("Cancel")];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title },
        (index) => {
          if (index < labels.length) onPick(index);
        },
      );
      return;
    }
    Alert.alert(
      title,
      undefined,
      options.map((label, index) =>
        index === labels.length
          ? { text: label, style: "cancel" as const }
          : { text: label, onPress: () => onPick(index) },
      ),
    );
  };

  const showAgentPicker = () => {
    const labels = agentChoices.map((agent) =>
      agent.actorId === primaryAgentId ? `✓ ${agent.displayName}` : agent.displayName,
    );
    if (primaryAgentId) labels.push(t("No agent"));
    showChoices(t("Agent"), labels, (index) => {
      selectPrimaryAgent(index < agentChoices.length ? agentChoices[index].actorId : null);
    });
  };

  const showWorkspacePicker = () => {
    if (!primaryAgent) return;
    const selectedId = agentConfig?.workspaceId ?? workspaceChoices[0]?.id;
    const labels = workspaceChoices.map((workspace) => {
      const label = workspace.path || workspace.id;
      return workspace.id === selectedId ? `✓ ${label}` : label;
    });
    showChoices(t("Working directory"), labels, (index) => {
      const workspace = workspaceChoices[index];
      if (!workspace) return;
      setAgentConfig({
        workspaceId: workspace.id,
        agentType:
          agentConfig?.agentType ??
          normalizeStoredAgentType(primaryAgent.defaultAgentType) ??
          "pi",
      });
    });
  };

  const appChoices = apps ?? [];
  const appLabel = pickedApp?.name ?? t("None");

  const showAppPicker = () => {
    // An app with no code yet cannot have a checkout on any agent's machine,
    // so it is listed but not selectable.
    const labels = [
      t("None"),
      ...appChoices.map((app) =>
        teamAppNeedsDesktopSetup(app)
          ? t("{{value}} (not initialized)", { value: app.name })
          : app.name,
      ),
      t("Cancel"),
    ];
    const dispatch = (index: number) => {
      if (index === 0) setPickedAppId(null);
      else if (index > 0 && index <= appChoices.length) {
        const app = appChoices[index - 1];
        if (!teamAppNeedsDesktopSetup(app)) setPickedAppId(app.id);
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: labels,
          cancelButtonIndex: labels.length - 1,
          disabledButtonIndices: appChoices
            .map((app, index) => (teamAppNeedsDesktopSetup(app) ? index + 1 : -1))
            .filter((index) => index > 0),
        },
        dispatch,
      );
      return;
    }
    Alert.alert(
      t("Link to app"),
      undefined,
      labels.map((label, index) => {
        if (index === labels.length - 1) {
          return { text: label, style: "cancel" as const };
        }
        return { text: label, onPress: () => dispatch(index) };
      }),
    );
  };

  const showAppSection = apps !== null;
  const eyebrow = showAppSection
    ? { agent: "01", collaborators: "02", app: "03", workspace: "04", firstMessage: "05" }
    : { agent: "01", collaborators: "02", app: "", workspace: "03", firstMessage: "04" };

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("New Session")}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons name="close" size={26} color={colors.onyx} />
        </Pressable>
      </GlassHeader>

      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", default: undefined })}
        style={styles.body}
      >
        <ScrollView
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Same order as iOS: who answers, who else is in, what app, and
              where the agent works. Ideas have no picker; a session is tied to
              one only when started from that idea's page. */}
          <View style={styles.section}>
            <SectionEyebrow label={`${eyebrow.agent} · ${t("AGENT")}`} />
            <Pressable
              accessibilityRole="button"
              disabled={agentChoices.length === 0}
              onPress={showAgentPicker}
              style={({ pressed }) => [
                styles.paperCard,
                styles.pickerRow,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <Text style={styles.cardTitle}>{t("Agent")}</Text>
              <View style={styles.pickerValue}>
                <Text
                  numberOfLines={1}
                  style={[styles.cardBody, primaryAgent ? null : styles.valueMuted]}
                >
                  {primaryAgent?.displayName ?? t("Choose agent")}
                </Text>
                <Ionicons color={colors.slate} name="chevron-down" size={14} />
              </View>
            </Pressable>
          </View>

          <View style={styles.section}>
            <SectionEyebrow label={`${eyebrow.collaborators} · ${t("COLLABORATORS")}`} />
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [
                styles.paperCard,
                styles.collaboratorsRow,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <View style={styles.collaboratorsBody}>
                {otherCollaborators.length === 0 ? (
                  <Text style={styles.collaboratorsPlaceholder}>{t("None")}</Text>
                ) : (
                  <ScrollView
                    contentContainerStyle={styles.chipRow}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                  >
                    {otherCollaborators.map((actor) => (
                      <CollaboratorChip
                        actor={actor}
                        key={actor.actorId}
                        onRemove={() => removeCollaborator(actor.actorId)}
                      />
                    ))}
                  </ScrollView>
                )}
              </View>
              <Ionicons color={colors.slate} name="chevron-forward" size={14} />
            </Pressable>
          </View>

          {showAppSection ? (
            <View style={styles.section}>
              <SectionEyebrow label={`${eyebrow.app} · ${t("APP")}`} />
              <Pressable
                accessibilityRole="button"
                disabled={appChoices.length === 0}
                onPress={showAppPicker}
                style={({ pressed }) => [
                  styles.paperCard,
                  styles.pickerRow,
                  pressed ? styles.rowPressed : null,
                ]}
              >
                <Text style={styles.cardTitle}>{t("Link to app")}</Text>
                <View style={styles.pickerValue}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.cardBody,
                      pickedApp === null ? styles.valueMuted : null,
                    ]}
                  >
                    {appLabel}
                  </Text>
                  <Ionicons color={colors.slate} name="chevron-down" size={14} />
                </View>
              </Pressable>
              {appBlockerMessage ? (
                <Text style={styles.appBlocker}>{appBlockerMessage}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionEyebrow label={`${eyebrow.workspace} · ${t("WORKING DIRECTORY")}`} />
            <Pressable
              accessibilityRole="button"
              // An app session always runs in the app's checkout.
              disabled={workspaceChoices.length === 0 || pickedApp !== null}
              onPress={showWorkspacePicker}
              style={({ pressed }) => [
                styles.paperCard,
                styles.pickerRow,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <Text style={styles.cardTitle}>{t("Working directory")}</Text>
              <View style={styles.pickerValue}>
                <Text
                  ellipsizeMode="head"
                  numberOfLines={1}
                  style={[styles.cardBody, workspaceRowValue.muted ? styles.valueMuted : null]}
                >
                  {workspaceRowValue.text}
                </Text>
                <Ionicons color={colors.slate} name="chevron-down" size={14} />
              </View>
            </Pressable>
          </View>

          <View style={styles.section}>
            <SectionEyebrow
              label={`${eyebrow.firstMessage} · ${t("FIRST MESSAGE")}`}
            />
            <View style={styles.paperCard}>
              <TextInput
                editable={!isBusy}
                multiline
                onChangeText={setFirstMessage}
                placeholder={t("What do you want to ask the team?")}
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.input}
                value={firstMessage}
              />
            </View>
          </View>
        </ScrollView>

        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}

        <View style={styles.actionsBar}>
          <Pressable
            disabled={!canSubmit}
            onPress={handleStart}
            style={({ pressed }) => [
              styles.cta,
              !canSubmit ? styles.ctaDisabled : null,
              pressed && canSubmit ? styles.ctaPressed : null,
            ]}
          >
            <Text style={styles.ctaText}>
              {isBusy ? t("Starting…") : t("Start session")}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <SheetModal
        onRequestClose={() => setPickerOpen(false)}
        visible={pickerOpen}
      >
        <MemberPickerSheet
          actors={pickerActors}
          excludeActorIds={excludedFromPicker}
          initialSelectedIds={collaboratorIds}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(picked) => {
            setCollaboratorIds(picked);
            setPickerOpen(false);
          }}
        />
      </SheetModal>

    </View>
  );
}

type CollaboratorChipProps = {
  actor: Actor;
  onRemove: () => void;
};

function CollaboratorChip({ actor, onRemove }: CollaboratorChipProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.chip}>
      <Text numberOfLines={1} style={styles.chipText}>
        {actor.displayName}
      </Text>
      <Pressable
        accessibilityLabel={t("Remove {{value}}", { value: actor.displayName })}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onRemove}
        style={styles.chipClose}
      >
        <Ionicons color={colors.basalt} name="close" size={12} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  actionsBar: {
    padding: spacing.lg,
  },
  appBlocker: {
    color: colors.cinnabarDeep,
    paddingHorizontal: 4,
    ...typography.caption,
  },
  body: {
    flex: 1,
    paddingTop: GLASS_HEADER_HEIGHT,
  },
  bodyContent: {
    gap: spacing.xl,
    padding: spacing.lg,
  },
  cardBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  cardTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  chip: {
    alignItems: "center",
    backgroundColor: colors.pebble,
    borderRadius: radii.pill,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  chipClose: {
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 2,
  },
  chipRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingVertical: 1,
  },
  chipText: {
    color: colors.onyx,
    ...typography.body,
    fontSize: 13.5,
    fontWeight: "600",
  },
  collaboratorsBody: {
    flex: 1,
  },
  collaboratorsPlaceholder: {
    color: colors.slate,
    ...typography.body,
  },
  collaboratorsRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 48,
  },
  cta: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: radii.button,
    justifyContent: "center",
    paddingVertical: 14,
  },
  ctaDisabled: {
    opacity: 0.35,
  },
  ctaPressed: {
    opacity: 0.9,
  },
  ctaText: {
    color: colors.paper,
    ...typography.cardTitle,
  },
  errorText: {
    color: colors.cinnabarDeep,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    ...typography.caption,
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
  input: {
    color: colors.onyx,
    minHeight: 96,
    padding: 0,
    textAlignVertical: "top",
    ...typography.body,
  },
  paperCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  pickerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  pickerValue: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    maxWidth: 200,
  },
  rowPressed: {
    opacity: 0.8,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  valueMuted: {
    color: colors.slate,
  },
});
