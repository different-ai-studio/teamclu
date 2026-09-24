import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import { ImageLightbox } from "../../sessions/components/ImageLightbox";
import { IdeaFeedActions } from "../components/IdeaFeedActions";
import { IdeaFeedMedia } from "../components/IdeaFeedMedia";
import {
  IdeaActivityTimeline,
  type IdeaActivityAuthor,
} from "../components/IdeaActivityTimeline";
import {
  IdeaProgressComposer,
  type ComposerAttachment,
  type IdeaImageSource,
} from "../components/IdeaProgressComposer";
import type { Idea, IdeaActivity, IdeaStatus } from "../idea-types";
import { t } from "../../../lib/i18n";

export type IdeaDetailScreenProps = {
  busyAction: "toggleStatus" | "archive" | "save" | null;
  creatorName: string | null;
  idea: Idea | null;
  isLoading: boolean;
  isRefreshing?: boolean;
  onArchive?: () => void;
  onClose: () => void;
  onRefresh?: () => void;
  onSaveContent?: (patch: { title: string; description: string }) => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
  onSetStatus?: (next: IdeaStatus) => void;
  onStartSession?: () => void;
  onToggleStatus?: () => void;
  /** Like/unlike the idea; `liked` is the desired state, not a toggle. */
  onToggleLike?: (liked: boolean) => void;
  relatedSessions?: ReadonlyArray<{
    sessionId: string;
    title: string;
    lastMessageAt: string;
  }>;
  /** Activity feed — newest first, as the Cloud API returns it. */
  activities?: ReadonlyArray<IdeaActivity>;
  activityAuthorsById?: Readonly<Record<string, IdeaActivityAuthor>>;
  isLoadingActivities?: boolean;
  /** Progress composer — omit `onSubmitProgress` to hide the composer. */
  composerAttachments?: ReadonlyArray<ComposerAttachment>;
  isSubmittingProgress?: boolean;
  onAddProgressImage?: (source: IdeaImageSource) => void;
  onRemoveProgressAttachment?: (id: string) => void;
  onSubmitProgress?: (text: string) => void;
};

type StatusPill = {
  label: string;
  foreground: string;
  background: string;
};

function statusPill(status: IdeaStatus): StatusPill {
  switch (status) {
    case "done":
      return {
        label: t("DONE"),
        foreground: hai.sage,
        background: "rgba(107,142,90,0.12)",
      };
    case "in_progress":
      return {
        label: t("IN PROGRESS"),
        foreground: hai.basalt,
        background: hai.pebble,
      };
    case "open":
    default:
      return {
        label: t("OPEN"),
        foreground: hai.cinnabar,
        background: "rgba(184,75,54,0.10)",
      };
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

export function IdeaDetailScreen({
  busyAction,
  creatorName,
  idea,
  isLoading,
  isRefreshing,
  onArchive,
  onClose,
  onRefresh,
  onSaveContent,
  onSelectSession,
  onSetStatus,
  onStartSession,
  onToggleStatus,
  onToggleLike,
  relatedSessions,
  activities,
  activityAuthorsById,
  isLoadingActivities,
  composerAttachments,
  isSubmittingProgress,
  onAddProgressImage,
  onRemoveProgressAttachment,
  onSubmitProgress,
}: IdeaDetailScreenProps) {
  const { t: tHook } = useTranslation();
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    setTitleDraft(idea?.title ?? "");
    setDescDraft(idea?.description ?? "");
  }, [idea?.ideaId, idea?.title, idea?.description]);

  const dirty =
    idea !== null &&
    (titleDraft.trim() !== idea.title.trim() ||
      descDraft.trim() !== (idea.description ?? "").trim());
  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{tHook("Idea")}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={Boolean(isRefreshing)}
              tintColor={colors.slate}
            />
          ) : undefined
        }
      >
        {isLoading && idea === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>{tHook("Loading idea…")}</Text>
          </View>
        ) : idea === null ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{tHook("Idea not found")}</Text>
            <Text style={styles.stateBody}>
              {tHook("The idea may have been archived or removed.")}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.hero}>
              <Pressable
                accessibilityLabel={tHook("Change idea status")}
                accessibilityRole={onSetStatus ? "button" : undefined}
                disabled={!onSetStatus || busyAction !== null}
                hitSlop={4}
                onPress={() => {
                  if (!onSetStatus) return;
                  const labels = [
                    tHook("Open"),
                    tHook("In Progress"),
                    tHook("Done"),
                    tHook("Cancel"),
                  ];
                  const values: IdeaStatus[] = ["open", "in_progress", "done"];
                  const dispatch = (index: number) => {
                    if (index < 0 || index >= values.length) return;
                    if (values[index] === idea.status) return;
                    onSetStatus(values[index]);
                  };
                  if (Platform.OS === "ios") {
                    ActionSheetIOS.showActionSheetWithOptions(
                      { options: labels, cancelButtonIndex: 3 },
                      dispatch,
                    );
                    return;
                  }
                  Alert.alert(tHook("Set status"), undefined, [
                    { text: labels[0], onPress: () => dispatch(0) },
                    { text: labels[1], onPress: () => dispatch(1) },
                    { text: labels[2], onPress: () => dispatch(2) },
                    { text: labels[3], style: "cancel" },
                  ]);
                }}
                style={[styles.pill, { backgroundColor: statusPill(idea.status).background }]}
              >
                <Text style={[styles.pillText, { color: statusPill(idea.status).foreground }]}>
                  {statusPill(idea.status).label}
                  {onSetStatus ? " ▾" : ""}
                </Text>
              </Pressable>
              <TextInput
                editable={!busyAction}
                multiline
                onChangeText={setTitleDraft}
                placeholder={tHook("Title")}
                placeholderTextColor={hai.slate}
                selectionColor={hai.cinnabar}
                style={[styles.heroTitle, idea.status === "done" ? styles.heroTitleDone : null]}
                value={titleDraft}
              />
            </View>

            <View style={styles.section}>
              <SectionEyebrow label={tHook("DESCRIPTION")} style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <TextInput
                  editable={!busyAction}
                  multiline
                  onChangeText={setDescDraft}
                  placeholder={tHook("Add a description")}
                  placeholderTextColor={hai.slate}
                  selectionColor={hai.cinnabar}
                  style={styles.descriptionText}
                  value={descDraft}
                />
              </View>
            </View>

            {idea.attachmentUrls.length > 0 ? (
              <View style={styles.section}>
                <IdeaFeedMedia urls={idea.attachmentUrls} />
              </View>
            ) : null}

            <View style={styles.engagement}>
              <IdeaFeedActions idea={idea} onToggleLike={onToggleLike} />
            </View>

            {dirty && onSaveContent ? (
              <Pressable
                accessibilityRole="button"
                disabled={busyAction !== null || titleDraft.trim().length === 0}
                onPress={() =>
                  onSaveContent({ title: titleDraft.trim(), description: descDraft })
                }
                style={({ pressed }) => [
                  styles.saveButton,
                  busyAction === "save" ? styles.actionBusy : null,
                  pressed ? styles.actionPressed : null,
                ]}
              >
                <Text style={styles.saveButtonText}>
                  {busyAction === "save" ? tHook("Saving…") : tHook("Save changes")}
                </Text>
              </Pressable>
            ) : null}

            <View style={styles.section}>
              <SectionEyebrow label={tHook("META")} style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <DetailRow label={tHook("Workspace")} value={idea.workspaceName ?? "—"} />
                <Hairline />
                <DetailRow label={tHook("Created by")} value={creatorName ?? "—"} />
                <Hairline />
                <DetailRow label={tHook("Created")} value={formatTimestamp(idea.createdAt)} />
                <Hairline />
                <DetailRow label={tHook("Updated")} value={formatTimestamp(idea.updatedAt)} />
              </View>
            </View>

            {activities ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={
                    activities.length > 0
                      ? tHook("ACTIVITY · {{count}}", { count: activities.length })
                      : tHook("ACTIVITY")
                  }
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  <IdeaActivityTimeline
                    activities={activities}
                    authorsById={activityAuthorsById}
                    isLoading={isLoadingActivities}
                    onSelectImage={setLightboxUrl}
                  />
                </View>
              </View>
            ) : null}

            {relatedSessions && relatedSessions.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={tHook("RELATED SESSIONS · {{count}}", { count: relatedSessions.length })}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {relatedSessions.map((row, index) => (
                    <View key={row.sessionId}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={
                          onSelectSession
                            ? () => onSelectSession(row.sessionId)
                            : undefined
                        }
                        style={({ pressed }) => [
                          styles.detailRow,
                          pressed && onSelectSession ? { opacity: 0.7 } : null,
                        ]}
                      >
                        <Text numberOfLines={1} style={styles.detailLabel}>
                          {row.title || tHook("Untitled session")}
                        </Text>
                        <Text style={styles.detailValue}>
                          {row.lastMessageAt
                            ? new Date(row.lastMessageAt).toLocaleDateString()
                            : "—"}
                        </Text>
                      </Pressable>
                      {index < relatedSessions.length - 1 ? <Hairline /> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {onStartSession ? (
              <Pressable
                accessibilityRole="button"
                onPress={onStartSession}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.actionStart,
                  pressed ? styles.actionPressed : null,
                ]}
              >
                <Text style={[styles.actionText, styles.actionStartText]}>
                  {tHook("Start a session")}
                </Text>
              </Pressable>
            ) : null}

            {(onToggleStatus || onArchive) ? (
              <View style={styles.actions}>
                {onToggleStatus ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={onToggleStatus}
                    style={({ pressed }) => [
                      styles.actionButton,
                      idea.status === "done"
                        ? styles.actionReopen
                        : styles.actionDone,
                      busyAction !== null ? styles.actionBusy : null,
                      pressed && busyAction === null ? styles.actionPressed : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.actionText,
                        idea.status === "done"
                          ? styles.actionReopenText
                          : styles.actionDoneText,
                      ]}
                    >
                      {busyAction === "toggleStatus"
                        ? tHook("Saving…")
                        : idea.status === "done"
                        ? tHook("Reopen")
                        : tHook("Mark done")}
                    </Text>
                  </Pressable>
                ) : null}
                {onArchive ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={onArchive}
                    style={({ pressed }) => [
                      styles.actionButton,
                      styles.actionArchive,
                      busyAction !== null ? styles.actionBusy : null,
                      pressed && busyAction === null ? styles.actionPressed : null,
                    ]}
                  >
                    <Text style={[styles.actionText, styles.actionArchiveText]}>
                      {busyAction === "archive" ? tHook("Archiving…") : tHook("Archive")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {idea && onSubmitProgress ? (
        <KeyboardAvoidingView
          // Android as well — edge-to-edge means `adjustResize` no longer
          // lifts the comment composer above the keyboard.
          behavior="padding"
          style={styles.composerDock}
        >
          <IdeaProgressComposer
            attachments={composerAttachments ?? []}
            isSubmitting={Boolean(isSubmittingProgress)}
            onAddImage={onAddProgressImage ?? (() => {})}
            onRemoveAttachment={onRemoveProgressAttachment ?? (() => {})}
            onSubmit={onSubmitProgress}
          />
        </KeyboardAvoidingView>
      ) : null}

      <ImageLightbox onClose={() => setLightboxUrl(null)} url={lightboxUrl} />
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  engagement: {
    paddingHorizontal: spacing.xs,
  },
  actionArchive: {
    backgroundColor: "rgba(184,75,54,0.10)",
  },
  actionArchiveText: {
    color: hai.cinnabar,
  },
  actionBusy: {
    opacity: 0.5,
  },
  actionButton: {
    alignItems: "center",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  actionDone: {
    backgroundColor: hai.onyx,
  },
  actionDoneText: {
    color: hai.paper,
  },
  actionPressed: {
    opacity: 0.85,
  },
  actionReopen: {
    backgroundColor: hai.pebble,
  },
  composerDock: {
    backgroundColor: colors.mist,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  actionStart: {
    backgroundColor: hai.cinnabar,
    marginBottom: spacing.sm,
  },
  actionStartText: {
    color: hai.paper,
  },
  actionReopenText: {
    color: hai.onyx,
  },
  actionText: {
    ...typography.cardTitle,
  },
  actions: {
    gap: spacing.sm,
  },
  saveButton: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: radii.button,
    paddingVertical: 12,
  },
  saveButtonText: {
    color: hai.paper,
    ...typography.cardTitle,
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
    // The glass header is pinned above this, so make room for it.
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  descriptionText: {
    color: colors.onyx,
    padding: spacing.md,
    ...typography.body,
  },
  detailLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  detailRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  detailValue: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.body,
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
  hero: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  heroTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
    fontSize: 22,
    lineHeight: 28,
  },
  heroTitleDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  pill: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radii.chip,
    height: 20,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  pillText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
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

export default IdeaDetailScreen;
