import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { createConfiguredShortcutsApi } from "../../src/features/shortcuts/api-provider";
import {
  isLeafShortcut,
  type Shortcut,
} from "../../src/features/shortcuts/shortcut-types";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";
import { createShortcutRowsCache } from "../../src/lib/db/team-cache";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";

// Module-scoped: one cache handle for the app, not one per render.
const shortcutsCache = createShortcutRowsCache();

export default function ShortcutsRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folderStack, setFolderStack] = useState<Array<{ id: string; label: string }>>([]);
  const [editMode, setEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const currentFolderId = folderStack.length > 0 ? folderStack[folderStack.length - 1].id : null;
  const currentFolderLabel = folderStack.length > 0 ? folderStack[folderStack.length - 1].label : null;

  useEffect(() => {
    if (!teamId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      // Paint last-known shortcuts first, as iOS does from SwiftData.
      const cached = await shortcutsCache.load(teamId);
      if (cached && !cancelled) {
        setShortcuts(cached);
        setIsLoading(false);
      }
      try {
        const rows = await createConfiguredShortcutsApi(cloudAuth).listShortcuts(teamId);
        if (!cancelled) setShortcuts(rows);
        void shortcutsCache.save(teamId, rows);
      } catch (err) {
        // Leave the cached rows on screen; the error line reports the refresh.
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("Couldn't load shortcuts."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const handleOpen = async (shortcut: Shortcut) => {
    if (!shortcut.target) return;
    if (shortcut.nodeType === "session") {
      router.push(`/(app)/sessions/${shortcut.target}`);
      return;
    }
    try {
      const supported = await Linking.canOpenURL(shortcut.target);
      if (supported) {
        await Linking.openURL(shortcut.target);
      }
    } catch {
      // Swallow — the user can see the error toast in a future polish pass.
    }
  };

  const visible = shortcuts.filter((row) => (row.parentId ?? null) === currentFolderId);
  const folders = visible.filter((row) => row.nodeType === "folder");
  const leaves = visible.filter(isLeafShortcut);

  const handleSaveRename = async (id: string) => {
    const next = editDraft.trim();
    if (!next) return;
    try {
      await createConfiguredShortcutsApi(cloudAuth).renameShortcut(id, next);
      setShortcuts((prev) =>
        prev.map((row) => (row.id === id ? { ...row, label: next } : row)),
      );
      setEditingId(null);
      setEditDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't rename shortcut."));
    }
  };

  const handleDelete = (shortcut: Shortcut) => {
    Alert.alert(
      t("Delete shortcut"),
      t("Remove \"{{value}}\" from your shortcuts?", { value: shortcut.label }),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await createConfiguredShortcutsApi(cloudAuth).deleteShortcut(shortcut.id);
              setShortcuts((prev) => prev.filter((row) => row.id !== shortcut.id));
            } catch (err) {
              setError(err instanceof Error ? err.message : t("Couldn't delete."));
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot}>
          {folderStack.length > 0 ? (
            <Pressable
              accessibilityLabel={t("Back to parent folder")}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setFolderStack((stack) => stack.slice(0, -1))}
              style={styles.headerSlotPressable}
            >
              <Ionicons color={colors.onyx} name="chevron-back" size={26} />
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.headerTitle}>{currentFolderLabel ?? t("Shortcuts")}</Text>
        <View style={styles.headerSlotGroup}>
          <Pressable
            accessibilityLabel={editMode ? t("Done editing") : t("Edit shortcuts")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              setEditMode((value) => !value);
              setEditingId(null);
              setEditDraft("");
            }}
            style={styles.headerSlotPressable}
          >
            <Text style={[styles.headerActionText, editMode ? styles.headerActionTextActive : null]}>
              {editMode ? t("Done") : t("Edit")}
            </Text>
          </Pressable>
          <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
            <Ionicons color={colors.onyx} name="close" size={26} />
          </Pressable>
        </View>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>{t("Loading shortcuts…")}</Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("Couldn't load shortcuts")}</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : shortcuts.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("No shortcuts")}</Text>
            <Text style={styles.body}>
              {t("Pin a URL, session, or team page to your shortcuts drawer to see it here.")}
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            {folders.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`${t("FOLDERS")} · ${folders.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {folders.map((folder, index) => {
                    const isEditing = editMode && editingId === folder.id;
                    return (
                      <View key={folder.id}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            if (editMode) {
                              setEditingId(folder.id);
                              setEditDraft(folder.label);
                              return;
                            }
                            setFolderStack((stack) => [
                              ...stack,
                              { id: folder.id, label: folder.label },
                            ]);
                          }}
                          style={({ pressed }) => [
                            styles.row,
                            pressed ? styles.rowPressed : null,
                          ]}
                        >
                          {editMode ? (
                            <Pressable
                              accessibilityLabel={t("Delete folder")}
                              accessibilityRole="button"
                              hitSlop={6}
                              onPress={() => handleDelete(folder)}
                              style={styles.deleteTile}
                            >
                              <Ionicons color={hai.paper} name="remove" size={14} />
                            </Pressable>
                          ) : (
                            <View style={styles.iconTile}>
                              <Ionicons color={colors.basalt} name="folder-outline" size={18} />
                            </View>
                          )}
                          {isEditing ? (
                            <TextInput
                              autoFocus
                              onBlur={() => {
                                if (editDraft.trim()) {
                                  void handleSaveRename(folder.id);
                                } else {
                                  setEditingId(null);
                                }
                              }}
                              onChangeText={setEditDraft}
                              onSubmitEditing={() => void handleSaveRename(folder.id)}
                              returnKeyType="done"
                              selectionColor={colors.cinnabar}
                              style={[styles.editInput, { flex: 1 }]}
                              value={editDraft}
                            />
                          ) : (
                            <Text style={styles.rowLabel}>{folder.label}</Text>
                          )}
                          <View style={{ flex: 1 }} />
                          {!editMode ? (
                            <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                          ) : null}
                        </Pressable>
                        {index < folders.length - 1 ? <Hairline /> : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {leaves.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`${t("PINNED")} · ${leaves.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {leaves.map((shortcut, index) => {
                    const isEditing = editMode && editingId === shortcut.id;
                    return (
                      <View key={shortcut.id}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            if (editMode) {
                              setEditingId(shortcut.id);
                              setEditDraft(shortcut.label);
                              return;
                            }
                            handleOpen(shortcut);
                          }}
                          style={({ pressed }) => [
                            styles.row,
                            pressed ? styles.rowPressed : null,
                          ]}
                        >
                          {editMode ? (
                            <Pressable
                              accessibilityLabel={t("Delete")}
                              accessibilityRole="button"
                              hitSlop={6}
                              onPress={() => handleDelete(shortcut)}
                              style={styles.deleteTile}
                            >
                              <Ionicons color={hai.paper} name="remove" size={14} />
                            </Pressable>
                          ) : (
                            <View style={styles.iconTile}>
                              <Ionicons
                                color={colors.cinnabar}
                                name={iconNameForLeaf(shortcut.nodeType)}
                                size={18}
                              />
                            </View>
                          )}
                          <View style={styles.rowBody}>
                            {isEditing ? (
                              <TextInput
                                autoFocus
                                onBlur={() => {
                                  if (editDraft.trim()) {
                                    void handleSaveRename(shortcut.id);
                                  } else {
                                    setEditingId(null);
                                  }
                                }}
                                onChangeText={setEditDraft}
                                onSubmitEditing={() => void handleSaveRename(shortcut.id)}
                                returnKeyType="done"
                                selectionColor={colors.cinnabar}
                                style={styles.editInput}
                                value={editDraft}
                              />
                            ) : (
                              <Text style={styles.rowLabel}>{shortcut.label}</Text>
                            )}
                            {!isEditing && shortcut.target ? (
                              <Text numberOfLines={1} style={styles.rowMeta}>
                                {shortcut.target}
                              </Text>
                            ) : null}
                          </View>
                          {!editMode ? (
                            <Ionicons color={colors.slate} name="open-outline" size={16} />
                          ) : null}
                        </Pressable>
                        {index < leaves.length - 1 ? <Hairline /> : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
        )}

        {folderStack.length === 0 ? (
          <View style={styles.section}>
            <SectionEyebrow label={t("SYSTEM")} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push("/(app)/settings")}
                style={({ pressed }) => [
                  styles.row,
                  pressed ? styles.rowPressed : null,
                ]}
              >
                <View style={styles.iconTile}>
                  <Ionicons color={colors.basalt} name="settings-outline" size={18} />
                </View>
                <Text style={styles.rowLabel}>{t("Settings")}</Text>
                <View style={{ flex: 1 }} />
                {Constants.expoConfig?.version ? (
                  <Text style={styles.rowVersion}>
                    {Constants.expoConfig.version}
                  </Text>
                ) : null}
                <Ionicons color={colors.slate} name="chevron-forward" size={16} />
              </Pressable>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function iconNameForLeaf(nodeType: Shortcut["nodeType"]): React.ComponentProps<typeof Ionicons>["name"] {
  switch (nodeType) {
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

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...typography.secondaryBody,
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
  headerSlotPressable: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  headerSlotGroup: {
    flexDirection: "row",
  },
  headerActionText: {
    color: colors.onyx,
    ...typography.body,
  },
  headerActionTextActive: {
    color: colors.cinnabar,
    fontWeight: "700",
  },
  deleteTile: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: 999,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  editInput: {
    color: colors.onyx,
    padding: 0,
    ...typography.body,
    fontWeight: "600",
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  iconTile: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  rowMeta: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  rowVersion: {
    color: colors.slate,
    paddingHorizontal: 6,
    ...typography.monoMeta,
  },
  rowPressed: {
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
  stateBlock: {
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});
