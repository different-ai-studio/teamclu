import { Ionicons } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { routeToHref, useOnboarding } from "./_layout";
import type { MyIdentity } from "../src/features/onboarding/onboarding-types";
import { Hairline } from "../src/ui/atoms/Hairline";
import { colors, iosType, radii, spacing } from "../src/ui/theme";

/**
 * Org picker shown after an email / password / OAuth sign-in when the person
 * has identities in more than one org (#1659) — iOS `IdentityPickerView`,
 * reached from `route == .selectIdentity`. Picking one swaps the session to
 * that identity; the normal team bootstrap (and team picker) follows.
 */
export default function SelectIdentityRoute() {
  const { t } = useTranslation();
  const { state, controller } = useOnboarding();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  if (state.route !== "selectIdentity") {
    const href = routeToHref(state.route);
    return href ? <Redirect href={href} /> : null;
  }

  const roleLabel = (adminType: number): string | null => {
    if (adminType >= 3) return t("Super admin");
    if (adminType === 2) return t("Admin");
    return null;
  };

  const pick = (identity: MyIdentity) => {
    if (busyUserId) return;
    setBusyUserId(identity.userId);
    void Promise.resolve(controller.chooseIdentity(identity)).finally(() =>
      setBusyUserId(null),
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerBlock}>
          <Text style={styles.title}>{t("Choose an organization")}</Text>
          <Text style={styles.body}>
            {t("You belong to more than one organization. Pick the one to enter this time.")}
          </Text>
        </View>

        {state.errorMessage ? (
          <Text style={styles.errorText}>{state.errorMessage}</Text>
        ) : null}

        <View style={styles.card}>
          {state.identityChoices.map((identity, index) => {
            const role = roleLabel(identity.adminType);
            return (
              <View key={identity.userId}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busyUserId !== null }}
                  disabled={busyUserId !== null}
                  onPress={() => pick(identity)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && busyUserId === null ? styles.rowPressed : null,
                  ]}
                  testID={`identityPicker.row.${identity.userId}`}
                >
                  <View style={styles.rowBody}>
                    <Text numberOfLines={1} style={styles.rowLabel}>
                      {identity.orgName ?? t("Unnamed organization")}
                    </Text>
                    {role ? (
                      <Text numberOfLines={1} style={styles.rowMeta}>
                        {role}
                      </Text>
                    ) : null}
                  </View>
                  {busyUserId === identity.userId ? (
                    <ActivityIndicator color={colors.slate} size="small" />
                  ) : identity.isCurrent ? (
                    <Text style={styles.rowMeta}>{t("Current account")}</Text>
                  ) : (
                    <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                  )}
                </Pressable>
                {index < state.identityChoices.length - 1 ? <Hairline /> : null}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...iosType.subheadline,
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
    paddingTop: spacing.xxxl,
  },
  errorText: {
    color: colors.cinnabarDeep,
    ...iosType.footnote,
  },
  headerBlock: {
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...iosType.body,
  },
  rowMeta: {
    color: colors.slate,
    ...iosType.caption,
  },
  rowPressed: {
    backgroundColor: colors.mist,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  title: {
    color: colors.onyx,
    ...iosType.title3,
  },
});
