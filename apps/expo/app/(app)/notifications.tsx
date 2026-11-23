import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import {
  createNotificationPrefsApi,
  defaultNotificationPrefs,
  type NotificationPrefs as PushPrefs,
} from "../../src/features/notifications/notification-prefs-api";
import { cloudAccessToken } from "../../src/lib/cloud-api/client";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { showToast } from "../../src/ui/Toast";
import { colors, radii, spacing, typography } from "../../src/ui/theme";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";

const STORAGE_KEY = "teamclu.notificationPrefs.v1";

type Prefs = {
  agentReply: boolean;
  mention: boolean;
  newSession: boolean;
  ideaUpdate: boolean;
};

const DEFAULT_PREFS: Prefs = {
  agentReply: true,
  mention: true,
  newSession: false,
  ideaUpdate: false,
};

export default function NotificationsRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [hydrated, setHydrated] = useState(false);
  const [pushPrefs, setPushPrefs] = useState<PushPrefs>(defaultNotificationPrefs);
  const userIdRef = useRef<string | null>(null);
  const pushApiRef = useRef(
    createNotificationPrefsApi({ getAccessToken: cloudAccessToken(cloudAuth) }),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed = JSON.parse(raw);
          setPrefs({ ...DEFAULT_PREFS, ...parsed });
        }
        const { data } = await cloudAuth.auth.getSession();
        userIdRef.current = data.session?.user.id ?? null;
        const remote = await pushApiRef.current.load();
        if (!cancelled) setPushPrefs(remote);
      } catch {
        // fall through with defaults
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // best-effort persistence
    }
  };

  const updatePush = async (patch: Partial<PushPrefs>) => {
    const next = { ...pushPrefs, ...patch };
    setPushPrefs(next);
    try {
      await pushApiRef.current.save(next);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : t("Couldn't save notification prefs"),
      );
    }
  };

  const formatDndMinutes = (value: number | null): string => {
    if (value === null) return "—";
    const h = Math.floor(value / 60).toString().padStart(2, "0");
    const m = (value % 60).toString().padStart(2, "0");
    return `${h}:${m}`;
  };

  const presetMinuteOptions = [
    { label: "21:00", value: 21 * 60 },
    { label: "22:00", value: 22 * 60 },
    { label: "23:00", value: 23 * 60 },
    { label: "00:00", value: 0 },
    { label: "06:00", value: 6 * 60 },
    { label: "07:00", value: 7 * 60 },
    { label: "08:00", value: 8 * 60 },
  ];

  const showDndPicker = (which: "start" | "end") => {
    const labels = [...presetMinuteOptions.map((o) => o.label), t("Cancel")];
    const dispatch = (index: number) => {
      if (index < 0 || index >= presetMinuteOptions.length) return;
      const v = presetMinuteOptions[index].value;
      if (which === "start") void updatePush({ dndStartMin: v });
      else void updatePush({ dndEndMin: v });
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1 },
        dispatch,
      );
      return;
    }
    Alert.alert(
      which === "start" ? t("DND start time") : t("DND end time"),
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
        <Text style={styles.headerTitle}>{t("Notifications")}</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <SectionEyebrow label={t("MESSAGES")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <ToggleRow
              disabled={!hydrated}
              helper={t("Notify me when an agent finishes a turn.")}
              label={t("Agent replies")}
              onChange={(value) => update({ agentReply: value })}
              value={prefs.agentReply}
            />
            <Hairline />
            <ToggleRow
              disabled={!hydrated}
              helper={t("Ping me when someone @mentions me in any session.")}
              label={t("@mentions")}
              onChange={(value) => update({ mention: value })}
              value={prefs.mention}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label={t("ACTIVITY")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <ToggleRow
              disabled={!hydrated}
              helper={t("Let me know when a teammate spins up a new session.")}
              label={t("New sessions")}
              onChange={(value) => update({ newSession: value })}
              value={prefs.newSession}
            />
            <Hairline />
            <ToggleRow
              disabled={!hydrated}
              helper={t("Track status changes on ideas I created or commented on.")}
              label={t("Idea updates")}
              onChange={(value) => update({ ideaUpdate: value })}
              value={prefs.ideaUpdate}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label={t("PUSH")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <ToggleRow
              disabled={!hydrated}
              helper={t("Master switch for push delivery (honored by the FC notification fan-out).")}
              label={t("Enable push")}
              onChange={(value) => updatePush({ enabled: value })}
              value={pushPrefs.enabled}
            />
            <Hairline />
            <ToggleRow
              disabled={!hydrated}
              helper={t("Skip push delivery during a fixed window each day.")}
              label={t("Do not disturb")}
              onChange={(value) => {
                if (value) {
                  void updatePush({
                    dndStartMin: pushPrefs.dndStartMin ?? 22 * 60,
                    dndEndMin: pushPrefs.dndEndMin ?? 7 * 60,
                  });
                } else {
                  void updatePush({ dndStartMin: null, dndEndMin: null });
                }
              }}
              value={pushPrefs.dndStartMin !== null}
            />
            {pushPrefs.dndStartMin !== null ? (
              <>
                <Hairline />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => showDndPicker("start")}
                  style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                >
                  <View style={styles.rowBody}>
                    <Text style={styles.rowLabel}>{t("Start")}</Text>
                  </View>
                  <Text style={styles.rowValue}>{formatDndMinutes(pushPrefs.dndStartMin)}</Text>
                </Pressable>
                <Hairline />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => showDndPicker("end")}
                  style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                >
                  <View style={styles.rowBody}>
                    <Text style={styles.rowLabel}>{t("End")}</Text>
                  </View>
                  <Text style={styles.rowValue}>{formatDndMinutes(pushPrefs.dndEndMin)}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>

        <Text style={styles.footnote}>
          {t(
            "Per-event preferences live on this device. iOS APNs registration, foreground presence, and notification tap routing sync with Supabase and the FC fan-out; Android FCM delivery still needs backend support.",
          )}
        </Text>
      </ScrollView>
    </View>
  );
}

function ToggleRow({
  disabled,
  helper,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  helper: string;
  label: string;
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHelper}>{helper}</Text>
      </View>
      <Switch
        disabled={disabled}
        onValueChange={onChange}
        thumbColor={value ? colors.paper : colors.paper}
        trackColor={{ false: colors.pebble, true: colors.cinnabar }}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
  footnote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
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
  rowHelper: {
    color: colors.slate,
    ...typography.caption,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowValue: {
    color: colors.basalt,
    ...typography.monoMeta,
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
});
