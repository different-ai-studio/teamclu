import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";

import { cloudApiBaseUrl } from "../../../lib/cloud-api/client";
import {
  DEFAULT_DESKTOP_DOWNLOAD_URL,
  displayUrl,
  fetchPublicConfig,
  resolveDesktopDownloadUrl,
} from "../../../lib/cloud-api/public-config";
import { PrimaryButton } from "../../../ui/button";
import { colors, iosType, spacing, typography } from "../../../ui/theme";
import { APP_NAME, OnboardingErrorNote } from "./OnboardingParts";

export type DesktopGuideMode =
  /** From the choice screen: continuing goes to sign-in. */
  | "beforeSignIn"
  /** From the no-team screen, already signed in: continuing creates the team. */
  | "signedIn";

/**
 * "Start a new team" → get the desktop app. A phone can't install it, so the
 * job is getting the link onto a computer: share it or copy it. The URL comes
 * from `GET /v1/config/public` (`desktopDownloadUrl`, #1588), with a built-in
 * fallback. Port of iOS `DesktopGuideView`.
 */
export function DesktopGuideScreen({
  errorMessage,
  isBusy = false,
  mode,
  onBack,
  onContinue,
}: {
  errorMessage?: string | null;
  isBusy?: boolean;
  mode: DesktopGuideMode;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const [downloadUrl, setDownloadUrl] = useState(DEFAULT_DESKTOP_DOWNLOAD_URL);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let base: string;
    try {
      base = cloudApiBaseUrl();
    } catch {
      return;
    }
    void fetchPublicConfig(base).then((config) => {
      if (!cancelled) setDownloadUrl(resolveDesktopDownloadUrl(config));
    });
    return () => {
      cancelled = true;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const share = () => {
    void Share.share({ message: downloadUrl, url: downloadUrl }).catch(() => {
      // Dismissed or unavailable — nothing to do.
    });
  };

  const copy = () => {
    void Clipboard.setStringAsync(downloadUrl).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityLabel={t("Back")}
        accessibilityRole="button"
        hitSlop={12}
        onPress={onBack}
        style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
      >
        <Ionicons color={colors.onyx} name="chevron-back" size={26} />
      </Pressable>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("Get the desktop app")}</Text>
          <Text style={styles.subtitle}>
            {t(
              "Your team's agents run on a computer. Install {{app}} for Mac or Windows there — that's where you create the team and invite people.",
              { app: APP_NAME },
            )}
          </Text>
        </View>

        <View style={styles.linkBlock}>
          <Text numberOfLines={2} selectable style={styles.linkText}>
            {displayUrl(downloadUrl)}
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={copy}
            testID="desktopGuide.copyButton"
          >
            <Text style={[styles.copyLabel, copied ? styles.copyLabelDone : null]}>
              {copied ? t("Copied") : t("Copy")}
            </Text>
          </Pressable>
        </View>

        {errorMessage ? <OnboardingErrorNote message={errorMessage} /> : null}
      </ScrollView>

      <View style={styles.actions}>
        <PrimaryButton
          label={t("Share download link")}
          onPress={share}
          testID="desktopGuide.shareButton"
        />
        <Pressable
          accessibilityRole="button"
          disabled={isBusy}
          onPress={onContinue}
          style={({ pressed }) => [styles.continueButton, pressed ? styles.pressed : null]}
          testID="desktopGuide.continueButton"
        >
          <Text style={styles.continueLabel}>
            {mode === "beforeSignIn"
              ? t("Sign in on this phone first")
              : t("Create my team now")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl + spacing.sm,
    paddingHorizontal: spacing.xxl,
  },
  backButton: {
    alignSelf: "flex-start",
    marginLeft: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.xs,
  },
  content: {
    gap: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
  },
  continueButton: {
    alignItems: "center",
    paddingVertical: 10,
  },
  continueLabel: {
    color: colors.basalt,
    ...iosType.subheadline,
    fontWeight: "500",
  },
  copyLabel: {
    color: colors.cinnabar,
    ...iosType.subheadline,
    fontWeight: "500",
  },
  copyLabelDone: {
    color: colors.sage,
  },
  header: {
    gap: 10,
    paddingHorizontal: spacing.xs,
  },
  linkBlock: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  linkText: {
    color: colors.onyx,
    flex: 1,
    fontFamily: typography.mono.fontFamily,
    fontSize: 15,
    lineHeight: 20,
  },
  pressed: {
    opacity: 0.6,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  subtitle: {
    color: colors.basalt,
    ...iosType.body,
  },
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 34,
    lineHeight: 40,
  },
});
