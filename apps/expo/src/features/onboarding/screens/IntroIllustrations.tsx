import { StyleSheet, Text, View } from "react-native";

import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, typography } from "../../../ui/theme";

/**
 * The three intro-card scenes, built from the app's own interface parts the
 * way iOS `IntroIllustrations.swift` does: paper cards, hairlines, monospace
 * avatars, an AGENT tag, a breathing status dot. No shadows; cinnabar in one
 * place per scene. Decorative only — hidden from accessibility by the caller.
 *
 * The small uppercase labels are interface chrome shown as part of the
 * picture, so they stay untranslated, like the tags they depict.
 */

function Avatar({ initials, agent }: { initials: string; agent?: boolean }) {
  return (
    <View style={[styles.avatar, agent ? styles.avatarAgent : null]}>
      <Text style={[styles.avatarText, agent ? styles.avatarTextAgent : null]}>{initials}</Text>
    </View>
  );
}

function Bar({ width, strong }: { width: number; strong?: boolean }) {
  return <View style={[styles.bar, { width }, strong ? styles.barStrong : null]} />;
}

/** 01 — one conversation: two members and an agent at work, one unread dot. */
export function SharedSessionIllustration() {
  return (
    <View style={styles.stage}>
      <View style={[styles.card, styles.sessionCard]}>
        <View style={styles.row}>
          <Avatar initials="LN" />
          <View style={styles.lines}>
            <Bar strong width={120} />
            <Bar width={80} />
          </View>
        </View>
        <View style={styles.hairline} />
        <View style={styles.row}>
          <Avatar agent initials="AI" />
          <View style={styles.lines}>
            <View style={styles.tagRow}>
              <Text style={styles.tag}>AGENT</Text>
              <StatusDot kind="working" size={7} />
            </View>
            <Bar width={140} />
          </View>
        </View>
        <View style={styles.hairline} />
        <View style={styles.row}>
          <Avatar initials="WZ" />
          <View style={styles.lines}>
            <Bar strong width={96} />
          </View>
          <View style={styles.unread} />
        </View>
      </View>
    </View>
  );
}

/** 02 — team knowledge: a stack of docs, members and agents linked to it. */
export function TeamKnowledgeIllustration() {
  return (
    <View style={styles.stage}>
      <View style={styles.knowledgeRow}>
        <Avatar initials="LN" />
        <View style={styles.dashed} />
        <View style={styles.docStack}>
          <View style={[styles.card, styles.doc, styles.docBack]} />
          <View style={[styles.card, styles.doc, styles.docMid]} />
          <View style={[styles.card, styles.doc]}>
            <Bar strong width={70} />
            <Bar width={54} />
            <Bar width={62} />
          </View>
        </View>
        <View style={styles.dashed} />
        <Avatar agent initials="AI" />
      </View>
      <Text style={styles.caption}>SYNCED</Text>
    </View>
  );
}

/** 03 — the computer works, the phone follows and makes the call. */
export function DesktopPhoneIllustration() {
  return (
    <View style={styles.stage}>
      <View style={styles.devicesRow}>
        <View style={[styles.card, styles.desktop]}>
          <View style={styles.tagRow}>
            <Text style={styles.tag}>AGENT</Text>
            <Text style={styles.tagMuted}>RUNNING</Text>
            <StatusDot kind="active" size={7} />
          </View>
          <Bar strong width={130} />
          <Bar width={110} />
          <Bar width={90} />
        </View>
        <View style={[styles.card, styles.phone]}>
          <View style={styles.notice}>
            <View style={styles.unread} />
            <Bar strong width={40} />
          </View>
          <Bar width={46} />
          <View style={styles.approve} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  approve: {
    borderColor: colors.hairlineStrong,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    height: 14,
    marginTop: 6,
    width: 46,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: colors.pebble,
    borderRadius: 4,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  avatarAgent: {
    backgroundColor: colors.onyx,
  },
  avatarText: {
    color: colors.basalt,
    fontFamily: typography.mono.fontFamily,
    fontSize: 10,
  },
  avatarTextAgent: {
    color: colors.paper,
  },
  bar: {
    backgroundColor: colors.pebble,
    borderRadius: 2,
    height: 5,
  },
  barStrong: {
    backgroundColor: colors.slate,
  },
  caption: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 10,
    letterSpacing: 2.5,
    marginTop: 18,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dashed: {
    borderColor: colors.slate,
    borderStyle: "dashed",
    borderTopWidth: 1,
    width: 22,
  },
  desktop: {
    gap: 8,
    height: 120,
    padding: 14,
    width: 190,
  },
  devicesRow: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 14,
  },
  doc: {
    gap: 7,
    height: 96,
    padding: 12,
    width: 92,
  },
  docBack: {
    left: 12,
    position: "absolute",
    top: -12,
  },
  docMid: {
    left: 6,
    position: "absolute",
    top: -6,
  },
  docStack: {
    marginHorizontal: 6,
  },
  hairline: {
    backgroundColor: colors.hairline,
    height: StyleSheet.hairlineWidth,
  },
  knowledgeRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  lines: {
    flex: 1,
    gap: 6,
  },
  notice: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
  },
  phone: {
    gap: 7,
    height: 132,
    padding: 10,
    width: 70,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingVertical: 10,
  },
  sessionCard: {
    paddingHorizontal: 14,
    width: 240,
  },
  stage: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  tag: {
    color: colors.onyx,
    fontFamily: typography.mono.fontFamily,
    fontSize: 9,
    letterSpacing: 1.5,
  },
  tagMuted: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 9,
    letterSpacing: 1.5,
  },
  tagRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  unread: {
    backgroundColor: colors.cinnabar,
    borderRadius: 4,
    height: 7,
    width: 7,
  },
});
