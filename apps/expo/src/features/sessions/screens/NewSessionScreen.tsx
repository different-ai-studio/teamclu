import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
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
import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import {
  AgentConfigSheet,
  type AgentConfigSelection,
  type AgentType,
} from "../components/AgentConfigSheet";
import { normalizeStoredAgentType } from "../components/agent-config-helpers";
import { MemberPickerSheet } from "./MemberPickerSheet";
import { SheetModal } from "../../../ui/SheetModal";

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  pi: "Pi",
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex",
};

export type AgentWorkspaceChoice = {
  id: string;
  path: string;
  agentId?: string | null;
};

export type NewSessionScreenProps = {
  actors?: ReadonlyArray<Actor>;
  currentMemberActorId?: string | null;
  errorMessage?: string | null;
  ideas?: ReadonlyArray<{ ideaId: string; displayTitle: string }>;
  isBusy?: boolean;
  onClose: () => void;
  onCreate: (payload: {
    firstMessage: string;
    collaboratorActorIds: string[];
    primaryAgentActorId: string | null;
    agentConfig: AgentConfigSelection | null;
    ideaId: string | null;
  }) => Promise<void> | void;
  selectedIdeaId?: string | null;
  workspaces?: ReadonlyArray<AgentWorkspaceChoice>;
};

export function NewSessionScreen({
  actors = [],
  currentMemberActorId = null,
  errorMessage = null,
  ideas = [],
  isBusy = false,
  onClose,
  onCreate,
  selectedIdeaId = null,
  workspaces = [],
}: NewSessionScreenProps) {
  const { t } = useTranslation();
  const [firstMessage, setFirstMessage] = useState("");
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const [primaryAgentId, setPrimaryAgentId] = useState<string | null>(null);
  const [pickedIdeaId, setPickedIdeaId] = useState<string | null>(selectedIdeaId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfigSelection | null>(null);

  const actorById = useMemo(() => {
    const map = new Map<string, Actor>();
    for (const actor of actors) {
      map.set(actor.actorId, actor);
    }
    return map;
  }, [actors]);

  const collaborators = useMemo(() => {
    return collaboratorIds
      .map((id) => actorById.get(id))
      .filter((actor): actor is Actor => Boolean(actor));
  }, [collaboratorIds, actorById]);

  const pickedAgentIds = useMemo(
    () => collaborators.filter(isAgentActor).map((actor) => actor.actorId),
    [collaborators],
  );

  const effectivePrimaryAgentId = useMemo(() => {
    if (pickedAgentIds.length === 0) return null;
    if (primaryAgentId && pickedAgentIds.includes(primaryAgentId)) {
      return primaryAgentId;
    }
    return pickedAgentIds[0];
  }, [pickedAgentIds, primaryAgentId]);

  const configuredAgent = useMemo(
    () =>
      actors.find((actor) => actor.actorId === effectivePrimaryAgentId) ?? null,
    [actors, effectivePrimaryAgentId],
  );

  const workspaceLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const workspace of workspaces) {
      map.set(workspace.id, workspace.path || workspace.id);
    }
    return map;
  }, [workspaces]);

  const excludedFromPicker = useMemo(() => {
    const set = new Set<string>();
    if (currentMemberActorId) set.add(currentMemberActorId);
    return set;
  }, [currentMemberActorId]);

  const removeCollaborator = useCallback((actorId: string) => {
    setCollaboratorIds((prev) => prev.filter((id) => id !== actorId));
    setPrimaryAgentId((prev) => (prev === actorId ? null : prev));
  }, []);

  const cyclePrimaryAgent = useCallback((actorId: string) => {
    setPrimaryAgentId(actorId);
  }, []);

  const canSubmit =
    firstMessage.trim().length > 0 && collaboratorIds.length > 0 && !isBusy;

  const handleStart = () => {
    if (!canSubmit) return;
    void onCreate({
      firstMessage: firstMessage.trim(),
      collaboratorActorIds: collaboratorIds,
      primaryAgentActorId: effectivePrimaryAgentId,
      agentConfig,
      ideaId: pickedIdeaId,
    });
  };

  const ideaLabel =
    pickedIdeaId === null
      ? t("None")
      : ideas.find((i) => i.ideaId === pickedIdeaId)?.displayTitle ?? "—";

  const showIdeaPicker = () => {
    if (ideas.length === 0) return;
    const labels = [t("None"), ...ideas.map((i) => i.displayTitle), t("Cancel")];
    const dispatch = (index: number) => {
      if (index === 0) setPickedIdeaId(null);
      else if (index > 0 && index <= ideas.length) {
        setPickedIdeaId(ideas[index - 1].ideaId);
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1 },
        dispatch,
      );
      return;
    }
    Alert.alert(
      t("Link to idea"),
      undefined,
      labels.map((label, index) => {
        if (index === labels.length - 1) {
          return { text: label, style: "cancel" as const };
        }
        return { text: label, onPress: () => dispatch(index) };
      }),
    );
  };

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
          <View style={styles.section}>
            <SectionEyebrow label={`01 · ${t("COLLABORATORS")}`} />
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
                {collaborators.length === 0 ? (
                  <Text style={styles.collaboratorsPlaceholder}>{t("Just you")}</Text>
                ) : (
                  <ScrollView
                    contentContainerStyle={styles.chipRow}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                  >
                    {collaborators.map((actor) => {
                      const isAgent = isAgentActor(actor);
                      const isPrimary =
                        isAgent && actor.actorId === effectivePrimaryAgentId;
                      return (
                        <CollaboratorChip
                          actor={actor}
                          isPrimary={isPrimary}
                          key={actor.actorId}
                          onMakePrimary={
                            isAgent ? () => cyclePrimaryAgent(actor.actorId) : undefined
                          }
                          onRemove={() => removeCollaborator(actor.actorId)}
                        />
                      );
                    })}
                  </ScrollView>
                )}
              </View>
              <Ionicons color={colors.slate} name="chevron-forward" size={14} />
            </Pressable>
          </View>

          <View style={styles.section}>
            <SectionEyebrow label={`02 · ${t("AGENT")}`} />
            <Pressable
              accessibilityRole="button"
              onPress={() => setAgentConfigOpen(true)}
              style={({ pressed }) => [
                styles.paperCard,
                styles.agentRow,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <Text style={styles.cardTitle}>{t("Configure agent")}</Text>
              <View style={styles.agentValue}>
                <Text numberOfLines={1} style={styles.cardBody}>
                  {agentConfig
                    ? `${AGENT_TYPE_LABELS[agentConfig.agentType]} · ${
                        workspaceLabelById.get(agentConfig.workspaceId) ??
                        agentConfig.workspaceId
                      }`
                    : t("Default")}
                </Text>
                <Ionicons color={colors.slate} name="chevron-forward" size={14} />
              </View>
            </Pressable>
          </View>

          {ideas.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow label={`03 · ${t("IDEA")}`} />
              <Pressable
                accessibilityRole="button"
                onPress={showIdeaPicker}
                style={({ pressed }) => [
                  styles.paperCard,
                  styles.ideaRow,
                  pressed ? styles.rowPressed : null,
                ]}
              >
                <Text style={styles.cardTitle}>{t("Link to idea")}</Text>
                <View style={styles.ideaValue}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.cardBody,
                      pickedIdeaId === null ? styles.ideaValueMuted : null,
                    ]}
                  >
                    {ideaLabel}
                  </Text>
                  <Ionicons color={colors.slate} name="chevron-down" size={14} />
                </View>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionEyebrow
              label={`${ideas.length > 0 ? "04" : "03"} · ${t("FIRST MESSAGE")}`}
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
          actors={actors as Actor[]}
          excludeActorIds={excludedFromPicker}
          initialSelectedIds={collaboratorIds}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(picked) => {
            setCollaboratorIds(picked);
            const stillPicked = primaryAgentId && picked.includes(primaryAgentId);
            if (!stillPicked) setPrimaryAgentId(null);
            setPickerOpen(false);
          }}
          primaryAgentId={effectivePrimaryAgentId}
        />
      </SheetModal>

      <SheetModal
        onRequestClose={() => setAgentConfigOpen(false)}
        presentationStyle="formSheet"
        visible={agentConfigOpen}
      >
        <AgentConfigSheet
          // The agent this configures is the session's primary one. It used to
          // say "Agent" and offer all three backends regardless of what that
          // agent can actually run — picking an unsupported one sends a
          // `runtime_start` the daemon cannot honour.
          actorDisplayName={configuredAgent?.displayName ?? t("Agent")}
          agentTypes={configuredAgent?.agentTypes}
          defaultType={
            agentConfig?.agentType ??
            normalizeStoredAgentType(configuredAgent?.defaultAgentType) ??
            "pi"
          }
          onCancel={() => setAgentConfigOpen(false)}
          onConfirm={(selection) => {
            setAgentConfig(selection);
            setAgentConfigOpen(false);
          }}
          workspaces={workspaces.map((workspace) => ({
            id: workspace.id,
            path: workspace.path,
          }))}
        />
      </SheetModal>
    </View>
  );
}

type CollaboratorChipProps = {
  actor: Actor;
  isPrimary: boolean;
  onMakePrimary?: () => void;
  onRemove: () => void;
};

function CollaboratorChip({
  actor,
  isPrimary,
  onMakePrimary,
  onRemove,
}: CollaboratorChipProps) {
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.chip,
        isPrimary ? styles.chipPrimary : null,
      ]}
    >
      {onMakePrimary ? (
        <Pressable
          accessibilityLabel={isPrimary ? t("Primary agent") : t("Make primary agent")}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onMakePrimary}
          style={styles.chipStar}
        >
          <Ionicons
            color={isPrimary ? colors.cinnabar : colors.slate}
            name={isPrimary ? "star" : "star-outline"}
            size={12}
          />
        </Pressable>
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          styles.chipText,
          isPrimary ? styles.chipTextPrimary : null,
        ]}
      >
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
  agentRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  agentValue: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    maxWidth: 200,
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
  chipPrimary: {
    backgroundColor: "rgba(184,75,54,0.10)",
  },
  chipRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingVertical: 1,
  },
  chipStar: {
    alignItems: "center",
    justifyContent: "center",
    paddingRight: 2,
  },
  chipText: {
    color: colors.onyx,
    ...typography.body,
    fontSize: 13.5,
    fontWeight: "600",
  },
  chipTextPrimary: {
    color: colors.cinnabarDeep,
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
  ideaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  ideaValue: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    maxWidth: 200,
  },
  ideaValueMuted: {
    color: colors.slate,
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
});
