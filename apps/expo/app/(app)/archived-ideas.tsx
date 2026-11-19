import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { IdeaRow } from "../../src/features/ideas/components/IdeaRow";
import type { Idea } from "../../src/features/ideas/idea-types";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { SkeletonRow } from "../../src/ui/atoms/SkeletonRow";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";
import { cloudAccessToken } from "../../src/lib/cloud-api/client";
import { colors, radii, spacing, typography } from "../../src/ui/theme";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";

export default function ArchivedIdeasRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  const refresh = async () => {
    if (!teamId) return;
    setIsLoading(true);
    try {
      const all = await createIdeasApi({ getAccessToken: cloudAccessToken(cloudAuth) }).listIdeas(teamId, {
        includeArchived: true,
      });
      setIdeas(all.filter((row) => row.archived));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const handleRestore = async (id: string) => {
    setRestoring(id);
    try {
      await createIdeasApi({ getAccessToken: cloudAccessToken(cloudAuth) }).unarchive(id);
      setIdeas((prev) => prev.filter((row) => row.ideaId !== id));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Archived Ideas")}</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              void refresh();
            }}
            refreshing={isLoading && ideas.length > 0}
            tintColor={colors.slate}
          />
        }
      >
        {isLoading ? (
          <View>
            <SkeletonRow avatar={false} />
            <SkeletonRow avatar={false} />
          </View>
        ) : ideas.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("No archived ideas")}</Text>
            <Text style={styles.stateBody}>
              {t("Archived ideas land here. Restore one to bring it back to the Ideas tab.")}
            </Text>
          </View>
        ) : (
          <View style={styles.section}>
            <SectionEyebrow
              label={t("ARCHIVED · {{count}}", { count: ideas.length })}
              style={styles.sectionEyebrow}
            />
            <View style={styles.card}>
              {ideas.map((idea, index) => (
                <View key={idea.ideaId}>
                  <View style={styles.row}>
                    <View style={styles.rowBody}>
                      <IdeaRow idea={idea} />
                    </View>
                    <Pressable
                      accessibilityLabel={t("Restore")}
                      accessibilityRole="button"
                      disabled={restoring === idea.ideaId}
                      hitSlop={6}
                      onPress={() => {
                        void handleRestore(idea.ideaId);
                      }}
                      style={({ pressed }) => [
                        styles.restoreButton,
                        pressed && restoring !== idea.ideaId ? styles.restorePressed : null,
                      ]}
                    >
                      <Text style={styles.restoreText}>
                        {restoring === idea.ideaId ? "…" : t("Restore")}
                      </Text>
                    </Pressable>
                  </View>
                  {index < ideas.length - 1 ? <Hairline /> : null}
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
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
  restoreButton: {
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.button,
    marginRight: spacing.md,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  restorePressed: {
    opacity: 0.7,
  },
  restoreText: {
    color: colors.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
  },
  rowBody: {
    flex: 1,
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
    gap: spacing.sm,
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
