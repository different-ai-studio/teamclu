import { Ionicons } from "@expo/vector-icons";
import { Tabs, usePathname, useRouter } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getUnreadSessionCount,
  subscribeUnreadSessionCount,
} from "../../../src/features/sessions/unread-store";
import {
  androidTabBarStyle,
  shouldHideNativeTabBar,
  tabBarLabelStyle,
} from "../../../src/ui/tab-bar";
import { colors } from "../../../src/ui/theme";

/**
 * The Voice tab (iOS #1557) is an action, not a place: pressing it opens the
 * full-screen capture modal and leaves the selected tab where it was. iOS
 * swapped Search out for it; Expo keeps Search and adds Voice last.
 */
const VOICE_CAPTURE_HREF = "/(app)/voice-capture";

type TabIconProps = {
  // `ColorValue`, not `string`: this is what expo-router hands `tabBarIcon`,
  // and a `string` parameter makes the callback unassignable to the prop.
  color: ColorValue;
  focused: boolean;
  size: number;
};

type IconName = keyof typeof Ionicons.glyphMap;

function makeIcon(activeName: IconName, idleName: IconName) {
  return function TabIcon({ color, focused, size }: TabIconProps) {
    return (
      <Ionicons name={focused ? activeName : idleName} size={size} color={color} />
    );
  };
}

/**
 * Tab bar, split by platform.
 *
 * iOS gets a real `UITabBar` via `NativeTabs`; Android gets a plain opaque JS
 * bar. The split is not a stylistic preference — it follows what each platform
 * can actually do:
 *
 * `RootTabView.swift` draws **no glass of its own**. It is a stock SwiftUI
 * `TabView` with `.tabViewStyle(.sidebarAdaptable)`, and its Liquid Glass comes
 * entirely from iOS 26. So matching iOS means handing the bar to the system,
 * not painting a better imitation of it — a JS tab bar with a blur behind it
 * tops out well short, which is the gap that prompted this.
 *
 * Android gets a plain opaque bar. It has no Liquid Glass to inherit, and the
 * imitation was worse than nothing there: `expo-blur`'s only real backdrop blur
 * on Android is the experimental Dimezis path, and it misbehaved on device. An
 * honest solid bar in the Hai palette beats a fake glass one that glitches —
 * "we can't blur" is not a licence to restyle, but it is a reason to stop
 * pretending. Switching Android to `NativeTabs` instead would only trade our
 * styling for Material 3 and gain nothing.
 */
export default function TabsLayout() {
  const [unread, setUnread] = useState(getUnreadSessionCount());
  useEffect(() => subscribeUnreadSessionCount((next) => setUnread(next)), []);

  if (Platform.OS === "ios") {
    return <IosNativeTabs unread={unread} />;
  }
  return <AndroidPlainTabs unread={unread} />;
}

/**
 * SF Symbols and roles are taken from `RootTabView.swift` rather than chosen —
 * the point is to be the same bar, so the symbol names match one for one.
 *
 * Deliberately no `blurEffect`: setting one applies a legacy `UIBlurEffect` and
 * **opts the bar out of Liquid Glass**, which is the opposite of the goal. The
 * default is what lets iOS 26 glaze it.
 */
function IosNativeTabs({ unread }: { unread: number }) {
  const { t } = useTranslation();
  const router = useRouter();
  // Session detail covers the composer; hide the system tab bar while that
  // route is showing. Driven from pathname (not a child setOptions) because
  // NativeTabs is a real UITabBar — JS `tabBarStyle` cannot reach it.
  const pathname = usePathname();
  const hideTabBar = shouldHideNativeTabBar(pathname);

  return (
    <NativeTabs
      // Mirrors `.tabViewStyle(.sidebarAdaptable)` on iOS.
      sidebarAdaptable
      tintColor={colors.cinnabar}
      badgeBackgroundColor={colors.cinnabar}
      // iOS 26: the bar shrinks out of the way as content scrolls under it.
      minimizeBehavior="onScrollDown"
      hidden={hideTabBar}
    >
      <NativeTabs.Trigger name="sessions">
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" />
        <NativeTabs.Trigger.Label>{t("Sessions")}</NativeTabs.Trigger.Label>
        {unread > 0 ? (
          <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="ideas">
        <NativeTabs.Trigger.Icon sf="lightbulb" />
        <NativeTabs.Trigger.Label>{t("Ideas")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="actors">
        <NativeTabs.Trigger.Icon sf="person.2" />
        <NativeTabs.Trigger.Label>{t("Actors")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* iOS declares this one as `Tab(value:role: .search)` — on iOS 26 the
          search role is what splits it into its own glass pill beside the
          others, so the role matters more than the icon here. */}
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>{t("Search")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* `disabled` stops the native bar from selecting the tab, but the
          navigator still emits `tabPress` (with `isPrevented`), which is the
          hook for opening the capture modal instead. */}
      <NativeTabs.Trigger
        disabled
        listeners={{ tabPress: () => router.push(VOICE_CAPTURE_HREF) }}
        name="voice"
      >
        <NativeTabs.Trigger.Icon sf="mic" />
        <NativeTabs.Trigger.Label>{t("Voice")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function AndroidPlainTabs({ unread }: { unread: number }) {
  const { t } = useTranslation();
  const router = useRouter();
  // The bar owns the bottom inset now: it sits flush against the display edge
  // and pads its own content clear of the gesture pill. The root reserves the
  // top only — see the note there.
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.cinnabar,
        tabBarInactiveTintColor: colors.slate,
        tabBarLabelStyle,
        // Opaque and in normal flow — the navigator reserves its height, so
        // content stops where the bar starts and no screen has to pad for it.
        //
        // The height and paddingBottom are computed rather than fixed. React
        // Navigation would derive both from the safe area itself, but only
        // correctly when it owns the bottom edge; the root used to claim it,
        // which left the tree floating one inset above the display with the
        // bar's own padding stacked on top. The root now takes the top only,
        // so the bar reaches the edge and pads its content clear of the
        // gesture pill.
        //
        // Shared with the session detail screen, which hides the bar and has
        // to put this exact value back — see `androidTabBarStyle`.
        tabBarStyle: androidTabBarStyle(insets.bottom),
        sceneStyle: styles.scene,
      }}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: t("Sessions"),
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.cinnabar,
            color: colors.paper,
            fontSize: 10,
            fontWeight: "700",
          },
          tabBarIcon: makeIcon("chatbubbles", "chatbubbles-outline"),
        }}
      />
      <Tabs.Screen
        name="ideas"
        options={{
          title: t("Ideas"),
          tabBarIcon: makeIcon("bulb", "bulb-outline"),
        }}
      />
      <Tabs.Screen
        name="actors"
        options={{
          title: t("Actors"),
          tabBarIcon: makeIcon("people", "people-outline"),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: t("Search"),
          tabBarIcon: makeIcon("search", "search-outline"),
        }}
      />
      <Tabs.Screen
        listeners={{
          tabPress: (event) => {
            event.preventDefault();
            router.push(VOICE_CAPTURE_HREF);
          },
        }}
        name="voice"
        options={{
          title: t("Voice"),
          tabBarIcon: makeIcon("mic", "mic-outline"),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  scene: {
    backgroundColor: colors.mist,
  },
});
