import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { Actor } from "../actor-types";
import type { LeaderboardEntry } from "../leaderboard-api";
import {
  actorIdHash,
  buildTeamStats,
  formatTokens,
  statInitials,
  TEAM_STATS_PERIODS,
  type ActorTokenStat,
  type SkillStat,
  type TeamStatsPeriod,
} from "../team-stats";

/**
 * Team statistics, ported from the iOS `TeamStatsSheet`: period picker,
 * tokens / sessions / skills summary cards, a token ranking, and a skills-usage
 * breakdown — all aggregated from the team leaderboard (see `team-stats.ts`).
 * While loading it shows a spinner; a team with no telemetry shows zeros.
 */

export type TeamStatsSheetProps = {
  actors: ReadonlyArray<Actor>;
  entries: ReadonlyArray<LeaderboardEntry>;
  period: TeamStatsPeriod;
  isLoading: boolean;
  errorMessage: string | null;
  onChangePeriod: (period: TeamStatsPeriod) => void;
  onClose: () => void;
};

/** Human avatar palette, hash-rotated per actor id (iOS `agentColor`). */
const HUMAN_PALETTE = [hai.basalt, hai.slate, hai.sage, hai.onyx];

/** Agent glyph colour by backend (iOS `agentGlyphColor`). */
function agentGlyphColor(agentType: string | null): string {
  switch (agentType) {
    case "claude":
    case "claude_code":
      return hai.cinnabar;
    case "opencode":
      return hai.sage;
    case "codex":
      return hai.basalt;
    default:
      return hai.basalt;
  }
}

export function TeamStatsSheet({
  actors,
  entries,
  errorMessage,
  isLoading,
  onChangePeriod,
  onClose,
  period,
}: TeamStatsSheetProps) {
  const { t } = useTranslation();
  const stats = useMemo(() => buildTeamStats({ entries, actors }), [entries, actors]);
  const maxSkillCount = Math.max(1, ...stats.skills.map((skill) => skill.count));

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Team Statistics")}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.periodPicker}>
          {TEAM_STATS_PERIODS.map((option) => {
            const selected = option.value === period;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={option.value}
                onPress={() => onChangePeriod(option.value)}
                style={[styles.periodOption, selected ? styles.periodOptionSelected : null]}
              >
                <Text
                  style={[styles.periodLabel, selected ? styles.periodLabelSelected : null]}
                >
                  {t(option.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {isLoading && entries.length === 0 ? (
          <View style={styles.stateBlock}>
            <ActivityIndicator color={colors.slate} />
          </View>
        ) : errorMessage ? (
          <View style={styles.stateBlock}>
            <Ionicons color={colors.slate} name="bar-chart-outline" size={28} />
            <Text style={styles.stateTitle}>{t("Stats Unavailable")}</Text>
            <Text style={styles.stateBody}>{errorMessage}</Text>
          </View>
        ) : (
          <>
            <View style={styles.summaryRow}>
              <SummaryCard
                icon="sparkles-outline"
                label={t("TOKENS")}
                value={formatTokens(stats.totalTokens)}
              />
              <SummaryCard
                icon="chatbubbles-outline"
                label={t("SESSIONS")}
                value={`${stats.totalSessions}`}
              />
              <SummaryCard
                icon="hammer-outline"
                label={t("SKILLS")}
                value={`${stats.totalSkills}`}
              />
            </View>

            {stats.actors.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionEyebrow}>{t("TOKEN RANKING")}</Text>
                <View style={styles.card}>
                  {stats.actors.map((stat, index) => (
                    <View key={stat.actorId}>
                      <TokenRankRow rank={index + 1} stat={stat} />
                      {index < stats.actors.length - 1 ? (
                        <Hairline style={styles.rankDivider} />
                      ) : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {stats.skills.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionEyebrow}>{t("SKILLS USAGE")}</Text>
                <View style={styles.card}>
                  {stats.skills.map((skill, index) => (
                    <View key={skill.name}>
                      <SkillRow max={maxSkillCount} skill={skill} />
                      {index < stats.skills.length - 1 ? (
                        <Hairline style={styles.skillDivider} />
                      ) : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: string;
}) {
  return (
    <View style={styles.summaryCard}>
      <Ionicons color={colors.basalt} name={icon} size={14} />
      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.summaryValue}>
        {value}
      </Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function TokenRankRow({ rank, stat }: { rank: number; stat: ActorTokenStat }) {
  const isTop = rank === 1;
  return (
    <View style={[styles.rankRow, isTop ? styles.rankRowTop : null]}>
      <Text style={[styles.rank, isTop ? styles.rankTop : null]}>{rank}</Text>
      <ActorDot stat={stat} />
      <Text numberOfLines={1} style={styles.rankName}>
        {stat.name}
      </Text>
      <Text style={[styles.rankTokens, isTop ? styles.rankTop : null]}>
        {formatTokens(stat.tokens)}
      </Text>
    </View>
  );
}

function ActorDot({ stat }: { stat: ActorTokenStat }) {
  const initials = statInitials(stat.name);
  if (stat.isAgent) {
    return (
      <View style={[styles.dot, styles.dotAgent]}>
        <Text style={[styles.dotText, { color: agentGlyphColor(stat.agentType) }]}>
          {initials}
        </Text>
      </View>
    );
  }
  const background = HUMAN_PALETTE[actorIdHash(stat.actorId) % HUMAN_PALETTE.length];
  return (
    <View style={[styles.dot, styles.dotHuman, { backgroundColor: background }]}>
      <Text style={[styles.dotText, styles.dotTextHuman]}>{initials}</Text>
    </View>
  );
}

function SkillRow({ max, skill }: { max: number; skill: SkillStat }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, skill.count / max)) : 0;
  return (
    <View style={styles.skillRow}>
      <View style={styles.skillHeader}>
        <Text style={styles.skillName}>{skill.name}</Text>
        <Text style={styles.skillCount}>{skill.count}</Text>
      </View>
      <View style={styles.barTrack}>
        {/* The gradient spans the FILLED width, not the track — iOS applies it
            to the fill capsule, so a shorter bar ends mid-ramp rather than at
            full cinnabar. */}
        <LinearGradient
          colors={SKILL_BAR_GRADIENT}
          end={{ x: 1, y: 0 }}
          start={{ x: 0, y: 0 }}
          style={[styles.barFill, { width: `${ratio * 100}%` }]}
        />
      </View>
    </View>
  );
}

/** Pebble → cinnabar, matching the iOS `LinearGradient` on the skill bar. */
const SKILL_BAR_GRADIENT = [hai.pebble, hai.cinnabar] as const;

const styles = StyleSheet.create({
  barFill: {
    borderRadius: 2,
    height: "100%",
    overflow: "hidden",
  },
  barTrack: {
    backgroundColor: hai.pebble,
    borderRadius: 2,
    height: 4,
    overflow: "hidden",
    width: "100%",
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
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  dot: {
    alignItems: "center",
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  dotAgent: {
    backgroundColor: hai.pebble,
    borderColor: colors.hairline,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dotHuman: {
    borderRadius: 13,
  },
  dotText: {
    fontSize: 9,
    fontWeight: "700",
  },
  dotTextHuman: {
    color: "#FFFFFF",
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
  periodLabel: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  periodLabelSelected: {
    color: colors.onyx,
  },
  periodOption: {
    alignItems: "center",
    borderRadius: radii.chip,
    flex: 1,
    paddingVertical: 6,
  },
  periodOptionSelected: {
    backgroundColor: colors.paper,
  },
  periodPicker: {
    backgroundColor: hai.pebble,
    borderRadius: radii.button,
    flexDirection: "row",
    padding: 2,
  },
  rank: {
    color: colors.slate,
    textAlign: "center",
    width: 18,
    ...typography.monoMeta,
    fontWeight: "700",
  },
  rankDivider: {
    marginLeft: 44,
  },
  rankName: {
    color: colors.onyx,
    flex: 1,
    ...typography.secondaryBody,
  },
  rankRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rankRowTop: {
    backgroundColor: "rgba(184,75,54,0.04)",
  },
  rankTokens: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  rankTop: {
    color: hai.cinnabar,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: 10,
  },
  sectionEyebrow: {
    color: "rgba(94,91,85,0.7)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.35,
    paddingHorizontal: spacing.xs,
  },
  skillCount: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  stateBlock: {
    alignItems: "center",
    gap: spacing.sm,
    justifyContent: "center",
    minHeight: 180,
    paddingHorizontal: spacing.lg,
  },
  stateBody: {
    color: colors.slate,
    textAlign: "center",
    ...typography.caption,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  skillDivider: {
    marginLeft: 14,
  },
  skillHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  skillName: {
    color: colors.onyx,
    ...typography.secondaryBody,
    fontWeight: "600",
  },
  skillRow: {
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  summaryCard: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 6,
    paddingVertical: 14,
  },
  summaryLabel: {
    color: colors.slate,
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryValue: {
    color: colors.onyx,
    fontSize: 20,
    fontWeight: "700",
    ...typography.mono,
  },
});

export default TeamStatsSheet;
