import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";
import {
  AGENT_TYPE_ORDER,
  AgentType,
  canConfirmSelection,
  initialWorkspaceId,
  resolveInitialAgentType,
  supportedAgentTypes,
} from "./agent-config-helpers";

export type { AgentType };
export {
  AGENT_TYPE_ORDER,
  canConfirmSelection,
  initialWorkspaceId,
  resolveInitialAgentType,
  supportedAgentTypes,
};

export type AgentConfigSelection = {
  workspaceId: string;
  agentType: AgentType;
};

export type AgentConfigSheetProps = {
  actorDisplayName: string;
  workspaces: { id: string; path: string }[];
  defaultType?: AgentType;
  /**
   * Backends this agent reports it can run (`actor.agentTypes`). Omitted means
   * "unknown", which shows all of them.
   */
  agentTypes?: ReadonlyArray<string>;
  onConfirm: (selection: AgentConfigSelection) => void;
  onCancel: () => void;
};

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  pi: "Pi",
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex",
};

export function AgentConfigSheet({
  actorDisplayName,
  workspaces,
  defaultType = "pi",
  agentTypes,
  onConfirm,
  onCancel,
}: AgentConfigSheetProps) {
  const { t } = useTranslation();
  const offeredTypes = supportedAgentTypes(agentTypes);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    initialWorkspaceId(workspaces),
  );
  const [selectedType, setSelectedType] = useState<AgentType>(() =>
    resolveInitialAgentType(defaultType, offeredTypes),
  );

  const canConfirm = canConfirmSelection(selectedWorkspaceId);

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityLabel={t("Cancel")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onCancel}
        >
          <Text style={styles.toolbarMuted}>{t("Cancel")}</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.toolbarTitle}>
          {t("Configure {{value}}", { value: actorDisplayName })}
        </Text>
        <Pressable
          accessibilityLabel={t("Add")}
          accessibilityRole="button"
          disabled={!canConfirm}
          hitSlop={8}
          onPress={() => {
            if (!canConfirm) return;
            onConfirm({ workspaceId: selectedWorkspaceId, agentType: selectedType });
          }}
        >
          <Text style={[styles.toolbarPrimary, !canConfirm && styles.toolbarDisabled]}>
            {t("Add")}
          </Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionHeader}>{t("WORKSPACE")}</Text>
        {workspaces.length === 0 ? (
          <Text style={styles.emptyHint}>{t("No workspaces available.")}</Text>
        ) : (
          workspaces.map((ws) => {
            const selected = ws.id === selectedWorkspaceId;
            return (
              <Pressable
                accessibilityRole="button"
                key={ws.id}
                onPress={() => setSelectedWorkspaceId(ws.id)}
                style={({ pressed }) => [
                  styles.workspaceRow,
                  pressed ? styles.workspaceRowPressed : null,
                ]}
              >
                <Ionicons
                  color={selected ? colors.cinnabar : colors.slate}
                  name={selected ? "radio-button-on" : "radio-button-off"}
                  size={18}
                />
                <Text numberOfLines={1} style={styles.workspacePath}>
                  {ws.path}
                </Text>
              </Pressable>
            );
          })
        )}

        <Text style={[styles.sectionHeader, styles.sectionHeaderSpaced]}>
          {t("AGENT TYPE")}
        </Text>
        <View style={styles.segmented}>
          {offeredTypes.map((type) => {
            const selected = type === selectedType;
            return (
              <Pressable
                accessibilityRole="button"
                key={type}
                onPress={() => setSelectedType(type)}
                style={({ pressed }) => [
                  styles.segment,
                  selected ? styles.segmentActive : null,
                  pressed ? styles.segmentPressed : null,
                ]}
              >
                <Text
                  style={[
                    styles.segmentLabel,
                    selected ? styles.segmentLabelActive : null,
                  ]}
                >
                  {AGENT_TYPE_LABELS[type]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  emptyHint: {
    color: colors.slate,
    paddingVertical: spacing.sm,
    ...typography.caption,
  },
  screen: {
    backgroundColor: colors.paper,
    flex: 1,
  },
  sectionHeader: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.monoMeta,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  sectionHeaderSpaced: {
    marginTop: spacing.lg,
  },
  segment: {
    alignItems: "center",
    flex: 1,
    paddingVertical: 10,
  },
  segmentActive: {
    backgroundColor: colors.paper,
  },
  segmentLabel: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "500",
  },
  segmentLabelActive: {
    color: colors.onyx,
    fontWeight: "700",
  },
  segmentPressed: {
    opacity: 0.85,
  },
  segmented: {
    backgroundColor: colors.mist,
    borderColor: colors.hairline,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    overflow: "hidden",
  },
  toolbar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderBottomColor: colors.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  toolbarDisabled: {
    opacity: 0.4,
  },
  toolbarMuted: {
    color: colors.basalt,
    ...typography.body,
  },
  toolbarPrimary: {
    ...typography.body,
    color: colors.cinnabar,
    fontWeight: "600",
  },
  toolbarTitle: {
    color: colors.onyx,
    flex: 1,
    paddingHorizontal: spacing.sm,
    textAlign: "center",
    ...typography.body,
    fontWeight: "600",
  },
  workspacePath: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  workspaceRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: 10,
  },
  workspaceRowPressed: {
    opacity: 0.7,
  },
});
