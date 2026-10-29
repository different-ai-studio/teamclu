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

/** 01 — one conversation: two members and an agent whose part is done, one unread dot. */
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
              <Text style={styles.done}>✓ DONE</Text>
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

const LEDGER = ["KNOWLEDGE", "SKILLS", "KEYS", "MEMORY"] as const;

function LedgerValue({ label }: { label: (typeof LEDGER)[number] }) {
  switch (label) {
    case "KNOWLEDGE":
      return <Text style={styles.tagMuted}>12</Text>;
    case "SKILLS":
      return <Text style={styles.tagMuted}>5</Text>;
    case "KEYS":
      return <Text style={styles.tagMuted}>••••</Text>;
    case "MEMORY":
      return <StatusDot kind="active" size={7} />;
  }
}

/** 02 — what the team keeps (knowledge, skills, keys, memory), linked to members and agents. */
export function TeamKnowledgeIllustration() {
  return (
    <View style={styles.stage}>
      <View style={styles.knowledgeRow}>
        <View style={styles.satellites}>
          <Avatar initials="LN" />
          <Avatar agent initials="AI" />
        </View>
        <View style={styles.dashed} />
        <View style={[styles.card, styles.ledger]}>
          {LEDGER.map((label, i) => (
            <View key={label} style={[styles.ledgerRow, i > 0 ? styles.ledgerDivider : null]}>
              <Text style={styles.tag}>{label}</Text>
              <LedgerValue label={label} />
            </View>
          ))}
        </View>
        <View style={styles.dashed} />
        <View style={styles.satellites}>
          <Avatar agent initials="AI" />
          <Avatar initials="WZ" />
        </View>
      </View>
    </View>
  );
}

/** 03 — a workflow run once becomes an app anyone can open again. */
export function WorkflowToAppIllustration() {
  return (
    <View style={styles.stage}>
      <View style={styles.flowRow}>
        <View style={[styles.card, styles.steps]}>
          {[70, 52, 80].map((w, i) => (
            <View key={w} style={styles.tagRow}>
              <Text style={styles.tagMuted}>{i + 1}</Text>
              <Bar strong={i === 0} width={w} />
            </View>
          ))}
        </View>
        <Text style={styles.arrow}>→</Text>
        <View style={[styles.card, styles.app]}>
          <View style={styles.tagRow}>
            <View style={styles.appIcon} />
            <Text style={styles.tagMuted}>APP</Text>
          </View>
          <Bar strong width={72} />
          <Bar width={56} />
          <View style={styles.run}>
            <Text style={styles.runLabel}>RUN</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  app: {
    gap: 9,
    padding: 14,
    width: 118,
  },
  appIcon: {
    backgroundColor: colors.onyx,
    borderRadius: 3,
    height: 14,
    width: 14,
  },
  arrow: {
    color: colors.slate,
    fontSize: 15,
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
    width: 16,
  },
  done: {
    color: colors.sage,
    fontFamily: typography.mono.fontFamily,
    fontSize: 9,
    letterSpacing: 1.5,
  },
  flowRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  hairline: {
    backgroundColor: colors.hairline,
    height: StyleSheet.hairlineWidth,
  },
  knowledgeRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  ledger: {
    paddingHorizontal: 12,
    paddingVertical: 2,
    width: 142,
  },
  ledgerDivider: {
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ledgerRow: {
    alignItems: "center",
    flexDirection: "row",
    height: 30,
    justifyContent: "space-between",
  },
  lines: {
    flex: 1,
    gap: 6,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingVertical: 10,
  },
  run: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: 4,
    height: 24,
    justifyContent: "center",
    marginTop: 4,
  },
  runLabel: {
    color: colors.paper,
    fontFamily: typography.mono.fontFamily,
    fontSize: 9,
    letterSpacing: 1.8,
  },
  satellites: {
    gap: 40,
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
  steps: {
    gap: 12,
    padding: 14,
    width: 128,
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
