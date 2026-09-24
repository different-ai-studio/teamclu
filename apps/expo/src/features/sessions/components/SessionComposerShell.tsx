import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, hai, radii, shadows, spacing, typography } from "../../../ui/theme";
import {
  agentButtonLabel,
  composerInputMode,
  composerRightButton,
} from "./composer-state";
import { RecordingWaveform } from "./RecordingWaveform";
import {
  buildComposerPresentation,
} from "./session-composer-copy";
import { useVoiceRecorder } from "./voice-recorder";
import type { UploadedAttachment } from "../attachment-upload";
import type { SessionDetailConnectionState } from "../session-detail-controller";

type SessionComposerShellProps = {
  composerText: string;
  connectionState: SessionDetailConnectionState;
  isSending: boolean;
  onAttach?: () => void;
  onChangeText: (value: string) => void;
  onRemovePendingAttachment?: (path: string) => void;
  onSend: () => void;
  pendingAttachments?: readonly UploadedAttachment[];
  sendErrorMessage: string | null;
  /** Display names of the agents currently selected, in chip order. */
  selectedAgentNames?: ReadonlyArray<string>;
  /** Opens the agents sheet — iOS's row-2 `@` button. */
  onOpenAgents?: () => void;
};


export function SessionComposerShell({
  composerText,
  connectionState,
  isSending,
  onAttach,
  onChangeText,
  onRemovePendingAttachment,
  onSend,
  onOpenAgents,
  pendingAttachments = [],
  selectedAgentNames = [],
  sendErrorMessage,
}: SessionComposerShellProps) {
  const { t } = useTranslation();
  const presentation = buildComposerPresentation({
    composerText,
    connectionState,
    isSending,
    pendingAttachmentCount: pendingAttachments.length,
    sendErrorMessage,
  });
  const recorder = useVoiceRecorder();
  const [recordError, setRecordError] = useState<string | null>(null);
  const hasPendingAttachments = pendingAttachments.length > 0;
  const rightButton = composerRightButton({
    hasText: composerText.trim().length > 0 || hasPendingAttachments,
    isRecording: recorder.isRecording,
  });
  const inputMode = composerInputMode(recorder.isRecording);
  const agentLabel = agentButtonLabel(selectedAgentNames);

  const handleMicToggle = async () => {
    setRecordError(null);
    try {
      if (recorder.isRecording) {
        const text = await recorder.stop();
        if (text) {
          onChangeText(`${composerText}${composerText.length > 0 ? " " : ""}${text}`);
        }
      } else {
        await recorder.start();
      }
    } catch (err) {
      setRecordError(err instanceof Error ? t(err.message) : t("Couldn't access microphone."));
    }
  };

  return (
    <View style={styles.wrapper}>
      {hasPendingAttachments ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.attachmentTray}
          contentContainerStyle={styles.attachmentTrayContent}
        >
          {pendingAttachments.map((attachment) => (
            <PendingAttachmentTile
              attachment={attachment}
              key={attachment.path}
              onRemove={
                onRemovePendingAttachment
                  ? () => onRemovePendingAttachment(attachment.path)
                  : undefined
              }
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.composerCard}>
        {/* Row 1 — the input, replaced wholesale by the waveform while
            recording, exactly as iOS swaps `inputMode`. */}
        <View style={styles.inputRow}>
          {inputMode === "waveform" ? (
            <RecordingWaveform level={recorder.level} />
          ) : (
            <TextInput
              editable={!isSending && connectionState !== "disconnected"}
              multiline
              onChangeText={onChangeText}
              placeholder={presentation.placeholder}
              placeholderTextColor={colors.faint}
              selectionColor={colors.coral}
              style={styles.input}
              value={composerText}
            />
          )}
        </View>

        <View style={styles.rowDivider} />

        {/* Row 2 — [+] · agent button · spacer · one right button. */}
        <View style={styles.actionRow}>
          <Pressable
            accessibilityLabel={t("Attach")}
            accessibilityRole="button"
            disabled={!onAttach}
            onPress={onAttach}
            style={styles.roundButton}
          >
            <Ionicons color={onAttach ? colors.onyx : colors.slate} name="add" size={20} />
          </Pressable>

          <Pressable
            accessibilityLabel={t("Agents, {{count}} selected", { count: selectedAgentNames.length })}
            accessibilityRole="button"
            disabled={!onOpenAgents}
            onPress={onOpenAgents}
            style={styles.agentButton}
          >
            <Ionicons color={colors.onyx} name="at" size={16} />
            {agentLabel ? (
              <Text numberOfLines={1} style={styles.agentButtonLabel}>
                {agentLabel}
              </Text>
            ) : null}
          </Pressable>

          <View style={styles.actionSpacer} />

          {rightButton === "send" ? (
            <Pressable
              accessibilityLabel={t("Send")}
              accessibilityRole="button"
              accessibilityState={{ disabled: presentation.isDisabled }}
              disabled={presentation.isDisabled}
              onPress={onSend}
              style={({ pressed }) => [
                styles.roundButton,
                styles.sendButton,
                presentation.isDisabled ? styles.sendButtonDisabled : null,
                pressed && !presentation.isDisabled ? styles.pressed : null,
              ]}
            >
              <Ionicons color={hai.mist} name="arrow-up" size={18} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={
                rightButton === "stopRecording" ? t("Stop recording") : t("Voice input")
              }
              accessibilityRole="button"
              onPress={handleMicToggle}
              style={({ pressed }) => [
                styles.roundButton,
                rightButton === "stopRecording" ? styles.micButtonRecording : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Ionicons
                color={rightButton === "stopRecording" ? hai.paper : colors.onyx}
                name={rightButton === "stopRecording" ? "stop" : "mic-outline"}
                size={18}
              />
            </Pressable>
          )}
        </View>
      </View>

      {recordError ?? (recorder.errorMessage ? t(recorder.errorMessage) : null) ? (
        <Text style={styles.helperTextError}>
          {recordError ?? t(recorder.errorMessage ?? "")}
        </Text>
      ) : presentation.helperText ? (
        <Text style={styles.helperText}>{presentation.helperText}</Text>
      ) : null}
    </View>
  );
}

function PendingAttachmentTile({
  attachment,
  onRemove,
}: {
  attachment: UploadedAttachment;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const mime = attachment.mime ?? "";
  const isImage = mime.startsWith("image/");
  const label = attachment.path.split("/").pop() ?? t("Attachment");
  return (
    <View style={styles.attachmentTile}>
      {isImage && attachment.publicUrl ? (
        <Image
          accessibilityLabel={label}
          resizeMode="cover"
          source={{ uri: attachment.publicUrl }}
          style={styles.attachmentPreviewImage}
        />
      ) : (
        <View style={styles.attachmentFilePreview}>
          <Ionicons color={colors.basalt} name="document-outline" size={18} />
          <Text numberOfLines={1} style={styles.attachmentFileLabel}>
            {label}
          </Text>
        </View>
      )}
      {onRemove ? (
        <Pressable
          accessibilityLabel={t("Remove {{value}}", { value: label })}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onRemove}
          style={styles.attachmentRemoveButton}
        >
          <Ionicons color={colors.paper} name="close" size={12} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /* Row 2 buttons are 32×32 with a 44pt tap target, matching iOS. */
  actionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 10,
  },
  actionSpacer: {
    flex: 1,
  },
  agentButton: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: 4,
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 8,
  },
  agentButtonLabel: {
    color: colors.onyx,
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "500",
  },
  inputRow: {
    paddingBottom: 4,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  micButtonRecording: {
    backgroundColor: hai.cinnabarDeep,
  },
  pressed: {
    opacity: 0.8,
  },
  roundButton: {
    alignItems: "center",
    borderRadius: 16,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  rowDivider: {
    backgroundColor: colors.hairline,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
  },
  attachmentFileLabel: {
    color: colors.basalt,
    maxWidth: 58,
    textAlign: "center",
    ...typography.caption,
  },
  attachmentFilePreview: {
    alignItems: "center",
    backgroundColor: colors.panel,
    gap: 4,
    height: "100%",
    justifyContent: "center",
    paddingHorizontal: 6,
    width: "100%",
  },
  attachmentPreviewImage: {
    borderRadius: radii.card,
    height: "100%",
    width: "100%",
  },
  attachmentRemoveButton: {
    alignItems: "center",
    backgroundColor: "rgba(34,32,29,0.72)",
    borderColor: colors.paper,
    borderRadius: 999,
    height: 20,
    justifyContent: "center",
    position: "absolute",
    right: 4,
    top: 4,
    width: 20,
  },
  attachmentTile: {
    backgroundColor: colors.paper,
    borderColor: colors.border,
    borderRadius: radii.card,
    borderWidth: 1,
    height: 64,
    overflow: "hidden",
    width: 64,
  },
  attachmentTray: {
    flexGrow: 0,
  },
  attachmentTrayContent: {
    gap: spacing.sm,
    paddingHorizontal: 2,
    paddingTop: 2,
  },
  composerCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    // iOS `composerCornerRadius`.
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    ...shadows.composer,
  },
  helperText: {
    color: colors.ink2,
    ...typography.caption,
  },
  input: {
    color: colors.onyx,
    // iOS `composerInputFontSize`.
    fontSize: 15,
    maxHeight: 132,
    padding: 0,
  },
  helperTextError: {
    color: hai.cinnabarDeep,
    ...typography.caption,
  },
  placeholder: {
    color: colors.mutedForeground,
    ...typography.body,
  },
  sendButton: {
    backgroundColor: hai.onyx,
  },
  sendButtonDisabled: {
    opacity: 0.35,
  },
  // Inset from the screen edges like the chip bar above it, so the card reads
  // as a floating bar rather than a slab glued to both sides.
  wrapper: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
});

export default SessionComposerShell;
