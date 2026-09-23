import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
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

import { ActorRow } from "../../actors/components/ActorRow";
import { isAgentActor, isMemberActor, type Actor } from "../../actors/actor-types";
import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { foldForSearch as normalize } from "../../search/search-matcher";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, radii, spacing, typography } from "../../../ui/theme";

export type MemberPickerSheetProps = {
  actors: Actor[];
  excludeActorIds?: ReadonlySet<string> | string[];
  initialSelectedIds?: ReadonlySet<string> | string[];
  isLoading?: boolean;
  onCancel: () => void;
  onConfirm: (selectedActorIds: string[]) => void;
  primaryAgentId?: string | null;
};

function toSet(value: ReadonlySet<string> | string[] | undefined): Set<string> {
  if (!value) return new Set();
  if (value instanceof Set) return new Set(value);
  return new Set(value);
}



export function MemberPickerSheet({
  actors,
  excludeActorIds,
  initialSelectedIds,
  isLoading = false,
  onCancel,
  onConfirm,
  primaryAgentId = null,
}: MemberPickerSheetProps) {
  const { t } = useTranslation();
  const excluded = useMemo(() => toSet(excludeActorIds), [excludeActorIds]);
  const [selected, setSelected] = useState<Set<string>>(() => toSet(initialSelectedIds));
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    return actors.filter(
      (actor) => (isMemberActor(actor) || isAgentActor(actor)) && !excluded.has(actor.actorId),
    );
  }, [actors, excluded]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return visible;
    const needle = normalize(q);
    return visible.filter((actor) =>
      [actor.displayName, actor.role ?? "", actor.agentKind ?? "", actor.actorId]
        .map(normalize)
        .some((haystack) => haystack.includes(needle)),
    );
  }, [query, visible]);

  const humans = filtered.filter(isMemberActor);
  const agents = filtered.filter(isAgentActor);

  const toggle = (actorId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(actorId)) next.delete(actorId);
      else next.add(actorId);
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm(Array.from(selected));
  };

  const canConfirm = selected.size > 0;

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <Pressable accessibilityLabel={t("Cancel")} hitSlop={8} onPress={onCancel} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("Add actors")}</Text>
        <Pressable
          accessibilityLabel={t("Confirm")}
          accessibilityState={{ disabled: !canConfirm }}
          disabled={!canConfirm}
          hitSlop={8}
          onPress={handleConfirm}
          style={styles.headerSlot}
        >
          <Ionicons
            color={canConfirm ? colors.cinnabar : colors.slate}
            name="checkmark"
            size={26}
          />
        </Pressable>
      </GlassHeader>

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t("Search actors")}
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel={t("Clear search")}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setQuery("")}
          >
            <Ionicons color={colors.slate} name="close-circle" size={16} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {isLoading && filtered.length === 0 ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>{t("Loading actors…")}</Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>{t("No matches")}</Text>
            <Text style={styles.stateBody}>
              {query.trim()
                ? t("Nothing in the directory matches that search.")
                : t("Invite teammates or agents on the Actors tab first.")}
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            {humans.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`${t("MEMBERS")} · ${humans.length}`}
                  style={styles.sectionLabel}
                />
                <View>
                  {humans.map((actor, index) => (
                    <SelectableRow
                      actor={actor}
                      isPrimary={false}
                      isSelected={selected.has(actor.actorId)}
                      key={actor.actorId}
                      onPress={() => toggle(actor.actorId)}
                      showDivider={index < humans.length - 1}
                    />
                  ))}
                </View>
              </View>
            ) : null}
            {agents.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`${t("AGENTS")} · ${agents.length}`}
                  style={styles.sectionLabel}
                />
                <View>
                  {agents.map((actor, index) => (
                    <SelectableRow
                      actor={actor}
                      isPrimary={actor.actorId === primaryAgentId}
                      isSelected={selected.has(actor.actorId)}
                      key={actor.actorId}
                      onPress={() => toggle(actor.actorId)}
                      showDivider={index < agents.length - 1}
                    />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

type SelectableRowProps = {
  actor: Actor;
  isPrimary: boolean;
  isSelected: boolean;
  onPress: () => void;
  showDivider: boolean;
};

function SelectableRow({
  actor,
  isPrimary,
  isSelected,
  onPress,
  showDivider,
}: SelectableRowProps) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      onPress={onPress}
      style={({ pressed }) => [styles.selectRow, pressed ? styles.selectRowPressed : null]}
    >
      <Ionicons
        color={isSelected ? colors.cinnabar : colors.slate}
        name={isSelected ? "checkmark-circle" : "ellipse-outline"}
        size={22}
        style={styles.checkmark}
      />
      <View style={styles.actorRowSlot}>
        <ActorRow actor={actor} />
        {isPrimary ? (
          <View style={styles.primaryBadge}>
            <Ionicons color={colors.cinnabar} name="star" size={12} />
            <Text style={styles.primaryBadgeText}>{t("PRIMARY")}</Text>
          </View>
        ) : null}
      </View>
      {showDivider ? <Hairline style={styles.rowDivider} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actorRowSlot: {
    flex: 1,
    position: "relative",
  },
  checkmark: {
    paddingLeft: spacing.lg,
  },
  content: {
    paddingBottom: spacing.xxxl,
  },
  groups: {
    gap: spacing.lg,
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
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  primaryBadge: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.chip,
    flexDirection: "row",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    position: "absolute",
    right: spacing.lg,
    top: "50%",
    transform: [{ translateY: -8 }],
  },
  primaryBadgeText: {
    color: colors.cinnabar,
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  // Pinned under the row. As an in-flow child of the horizontal row, the
  // hairline's `width: "100%"` took the whole row and squeezed the actor
  // column to nothing — every row but the last in a group showed no name.
  rowDivider: {
    bottom: 0,
    left: 70,
    position: "absolute",
    right: 0,
    width: "auto",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
    // The pinned header floats over the top of the screen; the search field is
    // not inside the scroll view, so it has to clear the header itself or it
    // sits hidden underneath it.
    marginTop: GLASS_HEADER_HEIGHT + spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  selectRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  selectRowPressed: {
    opacity: 0.6,
  },
  stateBlock: {
    gap: spacing.md,
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

export default MemberPickerSheet;
