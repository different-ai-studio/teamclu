import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { PrimaryButton } from "../../../ui/button";
import { colors, iosType, spacing, typography } from "../../../ui/theme";
import {
  SharedSessionIllustration,
  TeamKnowledgeIllustration,
  WorkflowToAppIllustration,
} from "./IntroIllustrations";
import { APP_NAME } from "./OnboardingParts";

// The three cards spell the product line: 协作 → 共享 → 创造
// (work together, keep the know-how, turn workflows into apps).
const CARDS = [
  {
    id: 0,
    eyebrow: "COLLABORATE",
    title: "Get it done with your AI partners",
    body: "Teammates and AI partners share one conversation — talk it through, split the work, ship it. You make the call; they do the legwork.",
    Illustration: SharedSessionIllustration,
  },
  {
    id: 1,
    eyebrow: "SHARE",
    title: "Your team's know-how, kept for everyone",
    body: "Knowledge, skills, keys and memory live with the team — every new member and every AI partner can use them from day one.",
    Illustration: TeamKnowledgeIllustration,
  },
  {
    id: 2,
    eyebrow: "CREATE",
    title: "Turn repeat work into your own apps",
    body: "Run a workflow once, and your AI partner can build it into an app. Next time just open it — and so can the whole team.",
    Illustration: WorkflowToAppIllustration,
  },
] as const;

/**
 * First-install intro: three swipeable cards. "Continue" pages forward, the
 * last card offers "Get Started", and "Skip" leaves from any earlier card. Shown once
 * (the caller persists the flag). Port of iOS `WelcomeView.IntroView` (#1589).
 */
export function IntroScreen({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const pager = useRef<ScrollView>(null);
  const isLastPage = page === CARDS.length - 1;

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setPage(Math.max(0, Math.min(CARDS.length - 1, next)));
  };

  const advance = () => {
    if (isLastPage) {
      onFinish();
      return;
    }
    const next = page + 1;
    pager.current?.scrollTo({ animated: true, x: next * width });
    setPage(next);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.brand}>{APP_NAME}</Text>
        {isLastPage ? null : (
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={onFinish}
            style={styles.skip}
            testID="welcome.skipButton"
          >
            <Text style={styles.skipLabel}>{t("Skip")}</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        ref={pager}
        horizontal
        onMomentumScrollEnd={onScrollEnd}
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        style={styles.pager}
        testID="welcome.introPager"
      >
        {CARDS.map(({ id, eyebrow, title, body, Illustration }) => (
          <View key={id} style={[styles.card, { width }]}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.illustration}
            >
              <Illustration />
            </View>
            <Text style={styles.eyebrow}>
              {`${String(id + 1).padStart(2, "0")}·${t(eyebrow)}`}
            </Text>
            <Text style={styles.title}>{t(title)}</Text>
            <Text style={styles.body}>{t(body)}</Text>
          </View>
        ))}
      </ScrollView>

      <View accessibilityElementsHidden style={styles.dots}>
        {CARDS.map((card) => (
          <View
            key={card.id}
            style={[styles.dot, card.id === page ? styles.dotActive : null]}
          />
        ))}
      </View>

      <View style={styles.actions}>
        <PrimaryButton
          label={t(isLastPage ? "Get Started" : "Continue")}
          onPress={advance}
          testID={isLastPage ? "welcome.getStartedButton" : "welcome.continueButton"}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    paddingBottom: spacing.xxxl + spacing.lg,
    paddingHorizontal: spacing.xxl,
  },
  body: {
    color: colors.basalt,
    ...iosType.body,
  },
  brand: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 22,
    textAlign: "center",
  },
  card: {
    paddingHorizontal: 28,
    paddingTop: 28,
  },
  dot: {
    backgroundColor: colors.slate,
    borderRadius: 3,
    height: 6,
    opacity: 0.4,
    width: 6,
  },
  dotActive: {
    backgroundColor: colors.onyx,
    opacity: 1,
  },
  dots: {
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    paddingBottom: spacing.xxl,
  },
  eyebrow: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 11,
    letterSpacing: 3,
    marginBottom: 10,
  },
  header: {
    justifyContent: "center",
    paddingTop: spacing.xxl,
  },
  illustration: {
    height: 260,
    marginBottom: 36,
  },
  pager: {
    flex: 1,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  skip: {
    position: "absolute",
    right: spacing.xxl,
    top: spacing.xxl,
  },
  skipLabel: {
    color: colors.slate,
    ...iosType.subheadline,
  },
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 30,
    lineHeight: 36,
    marginBottom: 12,
  },
});
