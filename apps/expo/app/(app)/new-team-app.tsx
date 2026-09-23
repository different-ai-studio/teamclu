import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import {
  CREATABLE_TEAM_APP_TYPES,
  TEAM_APP_VISIBILITIES,
  teamAppTypeIcon,
  teamAppTypeLabelKey,
  teamAppVisibilityLabelKey,
  type TeamAppType,
  type TeamAppVisibility,
} from "../../src/features/apps/team-app-types";
import {
  TeamAppNameRequiredError,
  createConfiguredTeamAppsApi,
} from "../../src/features/apps/team-apps-api";
import { rememberTeamApps } from "../../src/features/apps/team-apps-memory";
import { supabase } from "../../src/lib/supabase/client";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

/**
 * Create an app: a name, a kind, and who can see it. Port of iOS
 * `NewTeamAppSheet`.
 *
 * The desktop form also asks where the code comes from, but the branches that
 * import a folder or clone a repo need a daemon. This client only offers "we
 * make you a repo", and says plainly that a desktop has to finish the job.
 */
export default function NewTeamAppRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [name, setName] = useState("");
  const [type, setType] = useState<TeamAppType>("static_web");
  const [visibility, setVisibility] = useState<TeamAppVisibility>("personal");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = !isBusy && Boolean(teamId) && name.trim().length > 0;

  const handleCreate = async () => {
    if (!canCreate) return;
    setIsBusy(true);
    setError(null);
    try {
      const created = await createConfiguredTeamAppsApi(supabase).createApp(teamId, {
        name,
        type,
        visibility,
      });
      rememberTeamApps([created]);
      router.back();
      router.push({ pathname: "/(app)/team-app-detail", params: { appId: created.id } });
    } catch (err) {
      // Stay open: the name is still typed, and the common failures (a
      // duplicate slug, the repo host unreachable) are worth re-reading.
      if (err instanceof TeamAppNameRequiredError) {
        setError(t("Give the app a name first."));
      } else {
        setError(err instanceof Error ? err.message : t("Couldn't create app."));
      }
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("New app")}</Text>
        <Pressable
          accessibilityLabel={t("Close")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.back()}
          style={styles.headerSlot}
        >
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <SectionEyebrow label={t("NAME")} style={styles.sectionEyebrow} />
          <View style={[styles.card, styles.inputCard]}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!isBusy}
              maxLength={80}
              onChangeText={setName}
              onSubmitEditing={() => void handleCreate()}
              placeholder={t("e.g. Weekly meeting board")}
              placeholderTextColor={colors.slate}
              returnKeyType="done"
              selectionColor={colors.cinnabar}
              style={styles.nameInput}
              value={name}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label={t("TYPE")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            {CREATABLE_TEAM_APP_TYPES.map((option, index) => (
              <View key={option}>
                <OptionRow
                  icon={teamAppTypeIcon(option)}
                  label={t(teamAppTypeLabelKey(option))}
                  onPress={() => setType(option)}
                  selected={type === option}
                />
                {index < CREATABLE_TEAM_APP_TYPES.length - 1 ? (
                  <Hairline style={styles.divider} />
                ) : null}
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label={t("WHO CAN SEE IT")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            {TEAM_APP_VISIBILITIES.map((option, index) => (
              <View key={option}>
                <OptionRow
                  label={t(teamAppVisibilityLabelKey(option))}
                  onPress={() => setVisibility(option)}
                  selected={visibility === option}
                />
                {index < TEAM_APP_VISIBILITIES.length - 1 ? (
                  <Hairline style={styles.divider} />
                ) : null}
              </View>
            ))}
          </View>
        </View>

        <Text style={styles.footnote}>
          {t(
            "Creating it gives you a record first. The code is written and deployed once you open TeamClu on a computer — start here, finish on your computer.",
          )}
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={!canCreate}
          onPress={() => void handleCreate()}
          style={({ pressed }) => [
            styles.cta,
            canCreate ? styles.ctaActive : styles.ctaInactive,
            pressed && canCreate ? styles.ctaPressed : null,
          ]}
        >
          {isBusy ? (
            <ActivityIndicator color={hai.paper} />
          ) : (
            <Text
              style={[styles.ctaText, canCreate ? styles.ctaTextActive : styles.ctaTextInactive]}
            >
              {t("Create app")}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

function OptionRow({
  icon,
  label,
  onPress,
  selected,
}: {
  icon?: string;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.optionRow, pressed ? styles.optionRowPressed : null]}
    >
      {icon ? (
        <Ionicons
          color={colors.basalt}
          name={icon as React.ComponentProps<typeof Ionicons>["name"]}
          size={16}
          style={styles.optionIcon}
        />
      ) : null}
      <Text style={styles.optionLabel}>{label}</Text>
      {selected ? <Ionicons color={colors.cinnabar} name="checkmark" size={16} /> : null}
    </Pressable>
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
  cta: {
    alignItems: "center",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  ctaActive: {
    backgroundColor: hai.cinnabar,
  },
  ctaInactive: {
    backgroundColor: hai.pebble,
  },
  ctaPressed: {
    opacity: 0.88,
  },
  ctaText: {
    ...typography.cardTitle,
  },
  ctaTextActive: {
    color: hai.paper,
  },
  ctaTextInactive: {
    color: hai.slate,
  },
  divider: {
    marginLeft: spacing.md,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
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
  inputCard: {
    padding: spacing.md,
  },
  nameInput: {
    color: colors.onyx,
    padding: 0,
    ...typography.body,
  },
  optionIcon: {
    width: 22,
  },
  optionLabel: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  optionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
  optionRowPressed: {
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
});
