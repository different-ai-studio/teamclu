import { Stack } from "expo-router";

import { colors } from "../../../src/ui/theme";

/**
 * One session home, no tab bar (iOS #1752). Sessions is where the app opens;
 * Ideas, Actors and Search are pushed from the session list's header menu, and
 * new sessions and voice start from the composer bar under the list.
 *
 * The folder keeps its `(tabs)` name so every existing href — `/(app)/sessions/…`,
 * `/(app)/(tabs)/ideas` — still resolves; only the navigator changed.
 */
export const unstable_settings = {
  initialRouteName: "sessions",
};

export default function HomeStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.mist },
      }}
    >
      <Stack.Screen name="sessions" />
      <Stack.Screen name="ideas" />
      <Stack.Screen name="actors" />
      <Stack.Screen name="search" />
    </Stack>
  );
}
