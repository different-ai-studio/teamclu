import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { createActorsApi } from "../../src/features/actors/actor-api";
import {
  createConfiguredTeamJoinLinkApi,
  inferJoinLinkTtl,
  parseJoinLinkCap,
  type TeamJoinLink,
  type TeamJoinLinkTtl,
} from "../../src/features/onboarding/join-link";
import { CloudApiError, supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";
import { showToast } from "../../src/ui/Toast";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../src/ui/GlassHeader";

type InviteResult = {
  token: string;
  deeplink: string;
  expiresAt: string;
};

function buildDeeplink(token: string): string {
  return `teamclu://invite/${token}`;
}

/**
 * Invite screen. People join through the team's reusable join link only
 * (#1672 / #1674) — owners and admins manage it here; the form below it pairs
 * a new agent (another computer's daemon). iOS `MemberInviteSheet`.
 */
export default function InviteRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const teamRole = state.currentTeam?.role ?? null;
  const canManage = teamRole === "owner" || teamRole === "admin";

  const [agentKind, setAgentKind] = useState("daemon");
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changing the join link of a team still in the shared default org comes
  // back 403 `upgrade_required`. iOS swaps in an upgrade form rather than
  // reporting a dead end, and the team leaves the public org in place.
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [contact, setContact] = useState("");
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [invite, setInvite] = useState<InviteResult | null>(null);

  const [joinLink, setJoinLink] = useState<TeamJoinLink | null>(null);
  const [joinTtl, setJoinTtl] = useState<TeamJoinLinkTtl>("7d");
  const [joinCap, setJoinCap] = useState("");
  const [isJoinBusy, setIsJoinBusy] = useState(false);
  const [isJoinLoading, setIsJoinLoading] = useState(canManage);
  const [joinError, setJoinError] = useState<string | null>(null);

  const joinApi = useMemo(() => createConfiguredTeamJoinLinkApi(supabase), []);

  useEffect(() => {
    if (!canManage || !teamId) {
      setIsJoinLoading(false);
      return;
    }
    let cancelled = false;
    setIsJoinLoading(true);
    void joinApi
      .get(teamId)
      .then((row) => {
        if (cancelled) return;
        setJoinLink(row);
        if (row) {
          setJoinTtl(inferJoinLinkTtl(row));
          setJoinCap(row.maxUses === null ? "" : String(row.maxUses));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setJoinError(err instanceof Error ? err.message : t("Couldn't load the join link."));
        }
      })
      .finally(() => {
        if (!cancelled) setIsJoinLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, joinApi, t, teamId]);

  const parsedCap = parseJoinLinkCap(joinCap);

  const saveJoinLink = async (ttl: TeamJoinLinkTtl, maxUses: number | null, rotate: boolean) => {
    if (!teamId || isJoinBusy) return;
    setIsJoinBusy(true);
    setJoinError(null);
    try {
      const row = await joinApi.put(teamId, { ttl, maxUses, rotate });
      setJoinLink(row);
      setJoinTtl(ttl);
      setJoinCap(row.maxUses === null ? "" : String(row.maxUses));
    } catch (err) {
      if (err instanceof CloudApiError && err.code === "upgrade_required") {
        setNeedsUpgrade(true);
      } else {
        setJoinError(err instanceof Error ? err.message : t("Couldn't update the join link."));
      }
    } finally {
      setIsJoinBusy(false);
    }
  };

  const revokeJoinLink = async () => {
    if (!teamId || isJoinBusy) return;
    setIsJoinBusy(true);
    setJoinError(null);
    try {
      await joinApi.revoke(teamId);
      setJoinLink(null);
      setJoinCap("");
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : t("Couldn't revoke the join link."));
    } finally {
      setIsJoinBusy(false);
    }
  };

  const confirmRevoke = () => {
    Alert.alert(
      t("Revoke link"),
      t("People who have the link will no longer be able to join."),
      [
        { style: "cancel", text: t("Cancel") },
        {
          onPress: () => {
            void revokeJoinLink();
          },
          style: "destructive",
          text: t("Revoke link"),
        },
      ],
    );
  };

  const changeTtl = (next: TeamJoinLinkTtl) => {
    setJoinTtl(next);
    // Like iOS: an existing link follows the picker; without one the choice
    // waits for "Generate join link".
    if (!joinLink || !parsedCap.valid) return;
    if (inferJoinLinkTtl(joinLink) === next) return;
    void saveJoinLink(next, parsedCap.value, false);
  };

  const commitCap = () => {
    if (!joinLink || !parsedCap.valid) return;
    if (parsedCap.value === joinLink.maxUses) return;
    void saveJoinLink(joinTtl, parsedCap.value, false);
  };

  const copyJoinLink = async () => {
    if (!joinLink) return;
    await Clipboard.setStringAsync(joinLink.url);
    showToast("success", t("Join link copied"));
  };

  const shareJoinLink = async () => {
    if (!joinLink) return;
    try {
      await Share.share({ message: joinLink.url });
    } catch {
      // user-cancelled or platform-level error — silent.
    }
  };

  const canInvite = name.trim().length > 0 && !isCreating && invite === null;

  const handleCreate = async () => {
    if (!teamId || !canInvite) return;
    setIsCreating(true);
    setError(null);
    try {
      // Agents only: people come in through the join link (#1674).
      const result = await createActorsApi({
        getAccessToken: supabaseAccessToken(supabase),
      }).createInvite({
        teamId,
        kind: "agent",
        displayName: name.trim(),
        teamRole: null,
        agentKind,
      });
      setInvite({
        token: result.token,
        deeplink: result.deeplink || buildDeeplink(result.token),
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      if (err instanceof CloudApiError && err.code === "upgrade_required") {
        setNeedsUpgrade(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : t("Couldn't create invite."));
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleUpgrade = async () => {
    const trimmedOrg = orgName.trim();
    if (!teamId || trimmedOrg.length === 0 || isUpgrading) return;
    setIsUpgrading(true);
    setError(null);
    try {
      await createActorsApi({
        getAccessToken: supabaseAccessToken(supabase),
      }).upgradeAccount({ teamId, orgName: trimmedOrg, contact });
      // The team has its own org now, so what the user came here to do will
      // go through. Clear the prompt and let them retry.
      setNeedsUpgrade(false);
      setOrgName("");
      setContact("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Upgrade failed — please try again."));
    } finally {
      setIsUpgrading(false);
    }
  };

  const handleCopy = async () => {
    if (!invite) return;
    await Clipboard.setStringAsync(invite.deeplink);
    showToast("success", t("Invite link copied"));
  };

  const handleShare = async () => {
    if (!invite) return;
    try {
      await Share.share({ message: invite.deeplink });
    } catch {
      // user-cancelled or platform-level error — silent.
    }
  };

  const joinStatusLabel = (status: string): string => {
    switch (status) {
      case "active":
        return t("Active");
      case "expired":
        return t("Expired");
      case "exhausted":
        return t("Use limit reached");
      default:
        return status;
    }
  };

  const generateDisabled = isJoinBusy || !parsedCap.valid;

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Invite")}</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {canManage ? (
          <View style={styles.section}>
            <SectionEyebrow label={t("ANYONE WITH THE LINK")} style={styles.sectionEyebrow} />
            <Text style={styles.upgradeHint}>
              {t("Share this link to invite people. Anyone signed in who opens it joins the team.")}
            </Text>
            {isJoinLoading ? (
              <ActivityIndicator color={colors.slate} />
            ) : (
              <>
                <View style={styles.segmented}>
                  {(["7d", "30d", "never"] as const).map((ttl) => (
                    <SegmentChoice
                      disabled={isJoinBusy}
                      key={ttl}
                      label={
                        ttl === "7d" ? t("7 days") : ttl === "30d" ? t("30 days") : t("Never")
                      }
                      onPress={() => changeTtl(ttl)}
                      selected={joinTtl === ttl}
                    />
                  ))}
                </View>
                <View style={styles.card}>
                  <TextInput
                    editable={!isJoinBusy}
                    keyboardType="number-pad"
                    maxLength={6}
                    onBlur={commitCap}
                    onChangeText={setJoinCap}
                    onSubmitEditing={commitCap}
                    placeholder={t("Max uses (optional)")}
                    placeholderTextColor={colors.slate}
                    returnKeyType="done"
                    selectionColor={colors.cinnabar}
                    style={styles.input}
                    testID="invite.joinLinkCapField"
                    value={joinCap}
                  />
                  {joinLink ? (
                    <>
                      <Hairline />
                      <Text selectable style={styles.deeplink} testID="invite.joinLinkURL">
                        {joinLink.url}
                      </Text>
                      <Hairline />
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>{t("Uses")}</Text>
                        <Text style={styles.metaValue}>
                          {joinLink.maxUses === null
                            ? String(joinLink.useCount)
                            : `${joinLink.useCount} / ${joinLink.maxUses}`}
                        </Text>
                      </View>
                      <Hairline />
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>{t("Status")}</Text>
                        <Text style={styles.metaValue}>{joinStatusLabel(joinLink.status)}</Text>
                      </View>
                      <Hairline />
                      <View style={styles.actionRow}>
                        <ActionButton
                          disabled={isJoinBusy}
                          icon="share-outline"
                          label={t("Share")}
                          onPress={() => {
                            void shareJoinLink();
                          }}
                        />
                        <View style={styles.actionDivider} />
                        <ActionButton
                          disabled={isJoinBusy}
                          icon="copy-outline"
                          label={t("Copy")}
                          onPress={() => {
                            void copyJoinLink();
                          }}
                          testID="invite.copyJoinLinkButton"
                        />
                      </View>
                      <Hairline />
                      <View style={styles.actionRow}>
                        <ActionButton
                          disabled={isJoinBusy || !parsedCap.valid}
                          icon="refresh-outline"
                          label={t("Rotate link")}
                          onPress={() => {
                            if (!parsedCap.valid) return;
                            void saveJoinLink(joinTtl, parsedCap.value, true);
                          }}
                        />
                        <View style={styles.actionDivider} />
                        <ActionButton
                          destructive
                          disabled={isJoinBusy}
                          icon="trash-outline"
                          label={t("Revoke link")}
                          onPress={confirmRevoke}
                        />
                      </View>
                    </>
                  ) : null}
                </View>
                {!parsedCap.valid ? (
                  <Text style={styles.errorText}>
                    {t("Max uses must be a whole number of at least 1.")}
                  </Text>
                ) : null}
                {joinLink ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: generateDisabled }}
                    disabled={generateDisabled}
                    onPress={() => {
                      if (!parsedCap.valid) return;
                      void saveJoinLink(joinTtl, parsedCap.value, false);
                    }}
                    style={({ pressed }) => [
                      styles.cta,
                      generateDisabled ? styles.ctaInactive : styles.ctaActive,
                      pressed && !generateDisabled ? styles.ctaPressed : null,
                    ]}
                    testID="invite.generateJoinLinkButton"
                  >
                    {isJoinBusy ? (
                      <ActivityIndicator color={hai.paper} />
                    ) : (
                      <Text
                        style={[
                          styles.ctaText,
                          generateDisabled ? styles.ctaTextInactive : styles.ctaTextActive,
                        ]}
                      >
                        {t("Generate join link")}
                      </Text>
                    )}
                  </Pressable>
                )}
                {joinError ? <Text style={styles.errorText}>{joinError}</Text> : null}
              </>
            )}
          </View>
        ) : (
          <Text style={styles.upgradeHint}>
            {t("To invite people, ask a team owner or admin for the team's join link.")}
          </Text>
        )}

        <View style={styles.section}>
          <SectionEyebrow label={t("NEW AGENT")} style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              editable={invite === null && !isCreating}
              maxLength={64}
              onChangeText={setName}
              placeholder={t("Agent's name")}
              placeholderTextColor={colors.slate}
              selectionColor={colors.cinnabar}
              style={styles.input}
              value={name}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label={t("AGENT KIND")} style={styles.sectionEyebrow} />
          <View style={styles.segmented}>
            <SegmentChoice
              disabled={invite !== null}
              label={t("Daemon")}
              onPress={() => setAgentKind("daemon")}
              selected={agentKind === "daemon"}
            />
          </View>
        </View>

        {needsUpgrade ? (
          <View style={styles.section}>
            <SectionEyebrow label={t("Upgrade account")} style={styles.sectionEyebrow} />
            <Text style={styles.upgradeHint}>
              {t(
                "This team is still on the public org, so only you can use it. Upgrade and create your own team to invite members.",
              )}
            </Text>
            <View style={styles.card}>
              <TextInput
                editable={!isUpgrading}
                maxLength={64}
                onChangeText={setOrgName}
                placeholder={t("Team / org name")}
                placeholderTextColor={colors.slate}
                style={styles.input}
                value={orgName}
              />
              <Hairline />
              <TextInput
                editable={!isUpgrading}
                maxLength={64}
                onChangeText={setContact}
                placeholder={t("Contact (optional)")}
                placeholderTextColor={colors.slate}
                style={styles.input}
                value={contact}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: orgName.trim().length === 0 || isUpgrading }}
              disabled={orgName.trim().length === 0 || isUpgrading}
              onPress={() => {
                void handleUpgrade();
              }}
              style={({ pressed }) => [
                styles.upgradeButton,
                orgName.trim().length === 0 || isUpgrading
                  ? styles.upgradeButtonDisabled
                  : null,
                pressed ? styles.actionPressed : null,
              ]}
            >
              <Text style={styles.upgradeButtonLabel}>
                {isUpgrading ? t("Upgrading…") : t("Upgrade account")}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {invite ? (
          <View style={styles.section}>
            <SectionEyebrow label={t("SHARE INVITE")} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              <Text selectable style={styles.deeplink}>
                {invite.deeplink}
              </Text>
              <Hairline />
              <View style={styles.actionRow}>
                <ActionButton
                  icon="share-outline"
                  label={t("Share")}
                  onPress={() => {
                    void handleShare();
                  }}
                />
                <View style={styles.actionDivider} />
                <ActionButton
                  icon="copy-outline"
                  label={t("Copy")}
                  onPress={() => {
                    void handleCopy();
                  }}
                />
              </View>
            </View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={!canInvite}
            onPress={handleCreate}
            style={({ pressed }) => [
              styles.cta,
              canInvite ? styles.ctaActive : styles.ctaInactive,
              pressed && canInvite ? styles.ctaPressed : null,
            ]}
          >
            {isCreating ? (
              <ActivityIndicator color={hai.paper} />
            ) : (
              <Text
                style={[
                  styles.ctaText,
                  canInvite ? styles.ctaTextActive : styles.ctaTextInactive,
                ]}
              >
                {t("Create invite link")}
              </Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

function ActionButton({
  destructive,
  disabled,
  icon,
  label,
  onPress,
  testID,
}: {
  destructive?: boolean;
  disabled?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const tint = destructive ? hai.cinnabarDeep : colors.cinnabar;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        disabled ? styles.actionDisabled : null,
        pressed && !disabled ? styles.actionPressed : null,
      ]}
      testID={testID}
    >
      <Ionicons color={tint} name={icon} size={18} />
      <Text style={[styles.actionLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function SegmentChoice({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.segmentChoice,
        selected ? styles.segmentChoiceSelected : null,
        disabled && !selected ? styles.segmentChoiceDisabled : null,
      ]}
    >
      <Text
        style={[
          styles.segmentChoiceLabel,
          selected ? styles.segmentChoiceLabelSelected : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  upgradeHint: {
    color: colors.basalt,
    paddingHorizontal: spacing.lg,
    ...typography.caption,
  },
  upgradeButton: {
    alignItems: "center",
    backgroundColor: colors.onyx,
    borderRadius: radii.pill,
    marginHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  upgradeButtonDisabled: {
    opacity: 0.4,
  },
  upgradeButtonLabel: {
    color: colors.paper,
    ...typography.body,
    fontWeight: "600",
  },
  actionButton: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingVertical: spacing.md,
  },
  actionDivider: {
    backgroundColor: colors.hairline,
    width: StyleSheet.hairlineWidth,
  },
  actionLabel: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "600",
  },
  actionPressed: {
    opacity: 0.6,
  },
  actionDisabled: {
    opacity: 0.4,
  },
  metaLabel: {
    color: colors.basalt,
    ...typography.caption,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  metaValue: {
    color: colors.onyx,
    ...typography.caption,
  },
  actionRow: {
    flexDirection: "row",
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
  deeplink: {
    color: colors.basalt,
    padding: spacing.md,
    ...typography.monoMeta,
  },
  errorText: {
    color: hai.cinnabarDeep,
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
  input: {
    color: colors.onyx,
    padding: spacing.md,
    ...typography.body,
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
  segmentChoice: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: radii.pill,
    flex: 1,
    paddingVertical: 9,
  },
  segmentChoiceDisabled: {
    opacity: 0.5,
  },
  segmentChoiceLabel: {
    color: hai.basalt,
    ...typography.body,
    fontWeight: "600",
  },
  segmentChoiceLabelSelected: {
    color: hai.paper,
  },
  segmentChoiceSelected: {
    backgroundColor: hai.onyx,
  },
  segmented: {
    flexDirection: "row",
    gap: spacing.xs,
  },
});
