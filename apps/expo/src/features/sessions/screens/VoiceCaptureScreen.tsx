import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isAgentOnline, type ConnectedAgent } from "../../actors/connected-agent-types";
import { colors, iosType, spacing, typography } from "../../../ui/theme";
import { formatVoiceClock, voiceMeterBarHeight, voiceMeterBell, type VoicePhase } from "../voice-session";

/**
 * Full-bleed capture surface behind the Voice tab — iOS `VoiceCaptureView`.
 *
 * Opening it starts the recorder immediately, so this is never a landing page:
 * a live level meter, the transcript as it lands, and one verb. When there is
 * no default agent the agent list takes the meter's place (iOS shows the same
 * list as a sheet over this screen).
 */
export type VoiceCaptureScreenProps = {
  phase: VoicePhase;
  level: number;
  transcript: string;
  durationMs: number;
  pickableAgents: ReadonlyArray<ConnectedAgent>;
  onDone: () => void;
  onCancel: () => void;
  onPickAgent: (agent: ConnectedAgent) => void;
};

export function VoiceCaptureScreen({
  phase,
  level,
  transcript,
  durationMs,
  pickableAgents,
  onDone,
  onCancel,
  onPickAgent,
}: VoiceCaptureScreenProps) {
  const { t } = useTranslation();
  const hint = (() => {
    switch (phase) {
      case "preparing":
        return t("Getting the microphone ready…");
      case "recording":
        return transcript ? null : t("Listening…");
      case "awaitingAgent":
        return t("Choose an agent for this chat.");
      case "startingSession":
      case "done":
        return t("Starting your agent…");
      default:
        return null;
    }
  })();
  const capturing = phase === "preparing" || phase === "recording";
  const transcriptRef = useRef<ScrollView>(null);

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      {phase === "awaitingAgent" ? (
        <AgentPicker agents={pickableAgents} onCancel={onCancel} onPick={onPickAgent} />
      ) : (
        <>
          <View style={styles.center}>
            <Text style={[styles.clock, phase !== "recording" && styles.hidden]}>
              {formatVoiceClock(durationMs)}
            </Text>
            {phase === "startingSession" || phase === "done" ? (
              <View style={styles.meterSlot}>
                <ActivityIndicator color={colors.basalt} size="large" />
              </View>
            ) : (
              <VoiceLevelMeter animating={phase === "recording"} level={phase === "recording" ? level : 0} />
            )}
            <View style={styles.caption}>
              {hint ? <Text style={styles.hint}>{hint}</Text> : null}
              {transcript ? (
                <ScrollView
                  // Keep the newest words in view, like iOS's bottom anchor.
                  onContentSizeChange={() => transcriptRef.current?.scrollToEnd({ animated: false })}
                  ref={transcriptRef}
                  showsVerticalScrollIndicator={false}
                  style={styles.transcriptScroll}
                >
                  <Text style={styles.transcript}>{transcript}</Text>
                </ScrollView>
              ) : null}
            </View>
          </View>
          {capturing ? (
            <View style={styles.actions}>
              <Pressable
                accessibilityLabel={t("Done recording")}
                accessibilityRole="button"
                disabled={phase !== "recording"}
                onPress={onDone}
                style={[styles.doneButton, phase !== "recording" && styles.doneButtonIdle]}
                testID="voice.stopRecordingButton"
              >
                <Ionicons color={colors.mist} name="checkmark" size={30} />
              </Pressable>
              <Text style={styles.doneLabel}>{t("Done")}</Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={12}
                onPress={onCancel}
                style={styles.cancel}
                testID="voice.cancelRecordingButton"
              >
                <Text style={styles.cancelText}>{t("Cancel")}</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </SafeAreaView>
  );
}

function AgentPicker({
  agents,
  onCancel,
  onPick,
}: {
  agents: ReadonlyArray<ConnectedAgent>;
  onCancel: () => void;
  onPick: (agent: ConnectedAgent) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.picker}>
      <View style={styles.pickerHeader}>
        <Text style={styles.pickerTitle}>{t("Choose an agent")}</Text>
        <Pressable
          accessibilityLabel={t("Cancel")}
          accessibilityRole="button"
          hitSlop={12}
          onPress={onCancel}
          testID="voice.agentChoice.cancel"
        >
          <Ionicons color={colors.basalt} name="close" size={22} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.pickerBody}>
        <Text style={styles.sectionLabel}>{t("Agents")}</Text>
        <View style={styles.card}>
          {agents.map((agent, index) => {
            const online = isAgentOnline(agent);
            return (
              <Pressable
                accessibilityRole="button"
                key={agent.agentId}
                onPress={() => onPick(agent)}
                style={({ pressed }) => [
                  styles.row,
                  index < agents.length - 1 && styles.rowDivider,
                  pressed && styles.rowPressed,
                ]}
                testID={`voice.agentChoice.${agent.agentId}`}
              >
                <View
                  accessibilityLabel={online ? t("online") : t("offline")}
                  style={[styles.dot, { backgroundColor: online ? colors.sage : colors.slate }]}
                />
                <Text numberOfLines={1} style={styles.rowName}>
                  {agent.displayName}
                </Text>
                <Ionicons color={colors.slate} name="chevron-forward" size={14} />
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.footnote}>
          {t("Voice chats go here from now on. Change it any time on the agent's page.")}
        </Text>
      </ScrollView>
    </View>
  );
}

const METER_HEIGHT = 132;
const METER_BARS = 21;
const TICK_MS = 60;

/** iOS `VoiceLevelMeter`: a spindle of capsules riding a level-scaled wave. */
function VoiceLevelMeter({ level, animating }: { level: number; animating: boolean }) {
  const [time, setTime] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!animating || reduceMotion) return;
    const id = setInterval(() => setTime((Date.now() - startedAt.current) / 1000), TICK_MS);
    return () => clearInterval(id);
  }, [animating, reduceMotion]);

  const tick = animating && !reduceMotion ? time : 0;
  return (
    <View style={styles.meterSlot}>
      <View style={styles.meterBars}>
        {Array.from({ length: METER_BARS }, (_, index) => (
          <View
            key={index}
            style={[
              styles.meterBar,
              {
                height: voiceMeterBarHeight({
                  index,
                  barCount: METER_BARS,
                  level,
                  time: tick,
                  height: METER_HEIGHT,
                }),
                opacity: 0.3 + 0.55 * voiceMeterBell(index, METER_BARS),
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    paddingBottom: 44,
  },
  cancel: {
    marginTop: 24,
  },
  cancelText: {
    color: colors.slate,
    ...iosType.subheadline,
  },
  caption: {
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xxxl,
    paddingTop: spacing.xxxl,
    width: "100%",
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  clock: {
    color: colors.slate,
    letterSpacing: 2,
    marginBottom: spacing.xxxl,
    ...iosType.captionMono,
    fontSize: 13,
  },
  doneButton: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: 36,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  doneButtonIdle: {
    opacity: 0.35,
  },
  doneLabel: {
    color: colors.basalt,
    marginTop: 14,
    ...iosType.footnote,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  footnote: {
    color: colors.slate,
    paddingHorizontal: spacing.xxl,
    ...iosType.caption2,
  },
  hidden: {
    opacity: 0,
  },
  hint: {
    color: colors.slate,
    fontSize: 19,
    lineHeight: 25,
    textAlign: "center",
    ...typography.serif,
  },
  meterBar: {
    backgroundColor: colors.cinnabar,
    borderRadius: 2,
    width: 4,
  },
  meterBars: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
  },
  meterSlot: {
    alignItems: "center",
    height: METER_HEIGHT,
    justifyContent: "center",
  },
  picker: {
    flex: 1,
  },
  pickerBody: {
    gap: 10,
    paddingVertical: 14,
  },
  pickerHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  pickerTitle: {
    color: colors.onyx,
    ...iosType.headline,
  },
  root: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  rowDivider: {
    borderBottomColor: colors.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowName: {
    color: colors.onyx,
    flex: 1,
    fontSize: 14.5,
  },
  rowPressed: {
    backgroundColor: colors.pebble,
  },
  sectionLabel: {
    color: colors.slate,
    letterSpacing: 1,
    paddingHorizontal: spacing.xxl,
    textTransform: "uppercase",
    ...iosType.caption2Mono,
  },
  transcript: {
    color: colors.onyx,
    fontSize: 21,
    lineHeight: 28,
    textAlign: "center",
    ...typography.serif,
  },
  transcriptScroll: {
    maxHeight: 180,
    width: "100%",
  },
});
