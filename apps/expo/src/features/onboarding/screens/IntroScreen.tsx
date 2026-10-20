import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
  DesktopPhoneIllustration,
  SharedSessionIllustration,
  TeamKnowledgeIllustration,
} from "./IntroIllustrations";
import { APP_NAME } from "./OnboardingParts";

const CARDS = [
  {
    id: 0,
    eyebrow: "01",
    title: "Work alongside your AI allies",
    body: "Teammates and AI allies share one conversation — discuss, split the work, ship it.",
    Illustration: SharedSessionIllustration,
  },
  {
    id: 1,
    eyebrow: "02",
    title: "Team knowledge stays in sync",
    body: "The docs and know-how your team builds up are there for every member and every agent.",
    Illustration: TeamKnowledgeIllustration,
  },
  {
    id: 2,
    eyebrow: "03",
    title: "Your computer works, your phone follows",
    body: "Agents do the work on your computer. Follow along and make the call from your phone.",
    Illustration: DesktopPhoneIllustration,
  },
] as const;

/**
 * First-install intro: three swipeable cards, then "Get Started". Shown once
 * (the caller persists the flag). Port of iOS `WelcomeView.IntroView` (#1589).
 */
export function IntroScreen({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setPage(Math.max(0, Math.min(CARDS.length - 1, next)));
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.brand}>{APP_NAME}</Text>

      <ScrollView
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
            <Text style={styles.eyebrow}>{eyebrow}</Text>
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
          label={t("Get Started")}
          onPress={onFinish}
          testID="welcome.getStartedButton"
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
    paddingTop: spacing.xxl,
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
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 30,
    lineHeight: 36,
    marginBottom: 12,
  },
});
