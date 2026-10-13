import * as Application from "expo-application";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../ui/atoms/Hairline";
import { colors, radii, spacing, typography } from "../../ui/theme";
import {
  androidUpdateManifestUrl,
  fetchAndroidUpdateManifest,
  isUpdateAvailable,
  parseInstalledVersionCode,
  shouldCheckForUpdate,
  type AndroidUpdateManifest,
} from "./android-update";
import { downloadApk, installApk, type ApkDownload } from "./apk-installer";

type Phase =
  | { kind: "available" }
  | { kind: "downloading"; progress: number }
  | { kind: "downloaded"; fileUri: string }
  | { kind: "failed"; message: string };

function formatSize(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Checks android/latest.json on launch and whenever the app comes back to the
 * foreground (at most every few hours), and offers to download and install a
 * newer APK. Renders nothing on iOS, in dev builds without a manifest URL, or
 * when the installed versionCode is unknown.
 */
export function AndroidUpdatePrompt() {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState<AndroidUpdateManifest | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "available" });
  const lastCheckedAt = useRef<number | null>(null);
  const dismissedCode = useRef<number | null>(null);
  const download = useRef<ApkDownload | null>(null);
  const shownCode = useRef<number | null>(null);

  const url = Platform.OS === "android" ? androidUpdateManifestUrl() : null;
  const installedCode = parseInstalledVersionCode(Application.nativeBuildVersion);

  const check = useCallback(async () => {
    if (!url || installedCode === null) return;
    const now = Date.now();
    if (!shouldCheckForUpdate(lastCheckedAt.current, now)) return;
    lastCheckedAt.current = now;
    try {
      const next = await fetchAndroidUpdateManifest(url);
      // Same version already on screen: leave an in-flight download alone.
      if (isUpdateAvailable(next, installedCode, dismissedCode.current) && shownCode.current !== next.versionCode) {
        shownCode.current = next.versionCode;
        setPhase({ kind: "available" });
        setManifest(next);
      }
    } catch {
      // Offline or CDN hiccup: try again on the next foreground after the interval.
    }
  }, [url, installedCode]);

  useEffect(() => {
    void check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => sub.remove();
  }, [check]);

  const runInstall = useCallback(
    async (fileUri: string) => {
      try {
        await installApk(fileUri);
      } catch (error) {
        setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [],
  );

  const startDownload = useCallback(() => {
    if (!manifest) return;
    setPhase({ kind: "downloading", progress: 0 });
    const task = downloadApk(manifest, (progress) => {
      setPhase((p) => (p.kind === "downloading" ? { kind: "downloading", progress } : p));
    });
    download.current = task;
    task.promise
      .then((fileUri) => {
        if (download.current !== task) return;
        download.current = null;
        setPhase({ kind: "downloaded", fileUri });
        void runInstall(fileUri);
      })
      .catch((error: unknown) => {
        if (download.current !== task) return; // cancelled
        download.current = null;
        setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      });
  }, [manifest, runInstall]);

  const dismiss = useCallback(() => {
    const task = download.current;
    download.current = null;
    if (task) void task.cancel();
    dismissedCode.current = manifest?.versionCode ?? null;
    shownCode.current = null;
    setManifest(null);
  }, [manifest]);

  if (!manifest) return null;

  const busy = phase.kind === "downloading";
  const primary =
    phase.kind === "downloaded"
      ? { label: t("Install"), onPress: () => void runInstall(phase.fileUri) }
      : phase.kind === "failed"
        ? { label: t("Retry"), onPress: startDownload }
        : { label: t("Update now"), onPress: startDownload };

  return (
    <Modal animationType="fade" onRequestClose={dismiss} transparent visible>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{t("New version {{version}}", { version: manifest.version })}</Text>
          {manifest.notes ? <Text style={styles.body}>{manifest.notes}</Text> : null}
          {manifest.size > 0 ? (
            <Text style={styles.meta}>{t("Download size {{size}}", { size: formatSize(manifest.size) })}</Text>
          ) : null}
          {phase.kind === "downloading" ? (
            <View style={styles.progressWrap}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(phase.progress * 100)}%` }]} />
              </View>
              <Text style={styles.meta}>
                {t("Downloading… {{percent}}%", { percent: Math.round(phase.progress * 100) })}
              </Text>
            </View>
          ) : null}
          {phase.kind === "downloaded" ? (
            <Text style={styles.meta}>{t("Downloaded. Follow the system prompt to install.")}</Text>
          ) : null}
          {phase.kind === "failed" ? (
            <Text style={styles.error}>{t("Update failed: {{message}}", { message: phase.message })}</Text>
          ) : null}
          <Hairline style={styles.divider} />
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              onPress={dismiss}
              style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
            >
              <Text style={styles.buttonText}>{busy ? t("Cancel") : t("Later")}</Text>
            </Pressable>
            {busy ? null : (
              <>
                <View style={styles.buttonDivider} />
                <Pressable
                  accessibilityRole="button"
                  onPress={primary.onPress}
                  style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
                >
                  <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{primary.label}</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(34,32,29,0.35)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
  },
  body: {
    color: colors.basalt,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    ...typography.body,
  },
  button: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingVertical: spacing.md,
  },
  buttonDivider: {
    backgroundColor: colors.hairline,
    width: StyleSheet.hairlineWidth,
  },
  buttonPressed: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "500",
  },
  buttonTextPrimary: {
    color: colors.cinnabar,
    fontWeight: "700",
  },
  buttons: {
    flexDirection: "row",
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 380,
    width: "100%",
  },
  divider: {
    marginTop: spacing.lg,
  },
  error: {
    color: colors.cinnabar,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    ...typography.secondaryBody,
  },
  meta: {
    color: colors.slate,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    ...typography.secondaryBody,
  },
  progressFill: {
    backgroundColor: colors.cinnabar,
    borderRadius: 2,
    height: 4,
  },
  progressTrack: {
    backgroundColor: colors.pebble,
    borderRadius: 2,
    height: 4,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  progressWrap: {
    marginTop: spacing.md,
  },
  title: {
    color: colors.onyx,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    ...typography.cardTitle,
  },
});
