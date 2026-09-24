import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { colors, iosType, spacing, typography } from "../../../ui/theme";
import {
  phoneAccountInitial,
  phoneAccountLogoUrl,
  phoneAccountSubtitle,
  phoneAccountTitle,
  type PhoneAccount,
} from "../phone-login";

/**
 * One phone number, several accounts: pick which to sign in as. Each row shows
 * the account's org (logo + name) above the account itself. Port of the iOS
 * `LoginView.phoneAccountPickerSheet`.
 */
export function PhoneAccountPickerSheet({
  accounts,
  onCancel,
  onSelect,
}: {
  accounts: PhoneAccount[];
  onCancel: () => void;
  onSelect: (account: PhoneAccount) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onCancel}>
          <Text style={styles.cancel}>{t("Cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("Choose account")}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <Hairline />
      <ScrollView contentContainerStyle={styles.list}>
        {accounts.map((account, index) => {
          const subtitle = phoneAccountSubtitle(account);
          return (
            <View key={account.id}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onSelect(account)}
                style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                testID={`phoneAccount.${account.id}`}
              >
                <OrgLogo account={account} />
                <View style={styles.rowBody}>
                  {account.orgName ? (
                    <Text numberOfLines={1} style={styles.orgName}>
                      {account.orgName}
                    </Text>
                  ) : null}
                  <Text numberOfLines={1} style={styles.accountTitle}>
                    {phoneAccountTitle(account)}
                  </Text>
                  {subtitle ? (
                    <Text numberOfLines={1} style={styles.accountSubtitle}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {index < accounts.length - 1 ? <Hairline /> : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function OrgLogo({ account }: { account: PhoneAccount }) {
  const url = phoneAccountLogoUrl(account);
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        onError={() => setFailed(true)}
        source={{ uri: url }}
        style={styles.logo}
      />
    );
  }
  return (
    <View style={[styles.logo, styles.logoPlaceholder]}>
      <Text style={styles.logoInitial}>{phoneAccountInitial(account)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  accountSubtitle: {
    color: colors.basalt,
    ...iosType.footnote,
  },
  accountTitle: {
    color: colors.onyx,
    ...iosType.body,
    fontWeight: "500",
  },
  cancel: {
    color: colors.cinnabar,
    ...iosType.body,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerSpacer: {
    width: 48,
  },
  list: {
    paddingHorizontal: spacing.lg,
  },
  logo: {
    borderRadius: 10,
    height: 40,
    width: 40,
  },
  logoInitial: {
    color: colors.basalt,
    ...iosType.body,
    fontWeight: "600",
  },
  logoPlaceholder: {
    alignItems: "center",
    backgroundColor: colors.pebble,
    justifyContent: "center",
  },
  orgName: {
    color: colors.basalt,
    ...iosType.caption,
    fontWeight: "600",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowPressed: {
    opacity: 0.7,
  },
  sheet: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  title: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});
