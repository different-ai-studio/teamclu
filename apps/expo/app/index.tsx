import { Redirect } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useOnboarding, routeToHref } from "./_layout";
import { ApertureSplashScreen } from "../src/features/onboarding/screens/ApertureSplashScreen";
import { ServerSettingsSheet } from "../src/features/onboarding/screens/ServerSettingsSheet";
import { SheetModal } from "../src/ui/SheetModal";
import { PrimaryButton } from "../src/ui/button";
import { AppCard } from "../src/ui/card";
import { colors, spacing, typography } from "../src/ui/theme";

export default function IndexRoute() {
  const { t } = useTranslation();
  const { controller, retryBootstrap, applyServerChange, state } = useOnboarding();
  const href = routeToHref(state.route);
  // Leave as soon as bootstrap knows where to go. iOS holds the redirect until
  // the mark finishes its 2.8s lap (`ApertureSplashView.onLapFinished`); on
  // Android that wait was most of a cold start, so the splash is cut short.
  const [serverOpen, setServerOpen] = useState(false);

  if (href) {
    return <Redirect href={href} />;
  }

  if (state.route === "failed") {
    return (
      <View style={styles.screen}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>{t("We hit a loading problem")}</Text>
          <Text style={styles.body}>
            {state.errorMessage ?? t("We couldn't open TeamClu right now.")}
          </Text>
          <PrimaryButton
            isLoading={state.isBusy}
            label={t("Try again")}
            onPress={() => {
              void retryBootstrap().catch(() => {});
            }}
          />

          {/*
            Retry alone is a trap. Bootstrap reports every failure the same way,
            including an expired or otherwise rejected session — and that class
            of failure never recovers by retrying, so the screen becomes a
            permanent dead end that survives even killing the app, because the
            bad session is in storage. Signing out clears it.

            iOS shows both buttons here for the same reason
            (`onboardingError.retryButton` + `onboardingError.signOutButton`).
          */}
          <Pressable
            accessibilityRole="button"
            disabled={state.isBusy}
            onPress={() => {
              void controller.signOut().catch(() => {});
            }}
            style={({ pressed }) => [
              styles.signOut,
              pressed && !state.isBusy ? styles.signOutPressed : null,
            ]}
            testID="onboardingError.signOutButton"
          >
            <Text style={styles.signOutLabel}>{t("Sign out and start over")}</Text>
          </Pressable>

          {/* Rescue hatch when the saved server is unreachable — mirrors iOS
              OnboardingErrorView.onServerSettings. */}
          <Pressable
            accessibilityRole="button"
            disabled={state.isBusy}
            onPress={() => setServerOpen(true)}
            style={({ pressed }) => [
              styles.serverLink,
              pressed && !state.isBusy ? styles.signOutPressed : null,
            ]}
            testID="onboardingError.serverSettingsButton"
          >
            <Text style={styles.serverLinkLabel}>{t("Change server")}</Text>
          </Pressable>
        </AppCard>

        <SheetModal
          onRequestClose={() => setServerOpen(false)}
          visible={serverOpen}
        >
          <ServerSettingsSheet
            onCancel={() => setServerOpen(false)}
            onSaved={async () => {
              setServerOpen(false);
              await applyServerChange();
            }}
          />
        </SheetModal>
      </View>
    );
  }

  return <ApertureSplashScreen />;
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
    maxWidth: 440,
    width: "100%",
  },
  screen: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  signOut: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  signOutLabel: {
    color: colors.danger,
    ...typography.body,
    fontWeight: "600",
  },
  signOutPressed: {
    opacity: 0.6,
  },
  serverLink: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  serverLinkLabel: {
    color: colors.ink2,
    ...typography.body,
    fontWeight: "500",
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
