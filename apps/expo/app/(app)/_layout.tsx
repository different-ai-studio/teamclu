import { Stack } from "expo-router";
import { StyleSheet, View } from "react-native";

import { colors } from "../../src/ui/theme";

export default function AppLayout() {
  return (
    <View style={styles.layout}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="home" />
        <Stack.Screen
          name="new-session"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="voice-capture"
          options={{
            // Full-bleed like iOS's capture surface; the screen owns its own
            // Cancel, and a swipe-down mid-take would be easy to trigger by
            // accident.
            presentation: "fullScreenModal",
            animation: "slide_from_bottom",
            gestureEnabled: false,
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="session-members"
          options={{
            presentation: "formSheet",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="actor-detail"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="idea-stats"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="team-stats"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="actor-resources"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="actor-ideas"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="pending-invites"
          options={{
            presentation: "formSheet",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="switch-team"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="idea-detail"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="attach"
          options={{
            presentation: "formSheet",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
            sheetAllowedDetents: [0.4, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="workspaces"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="edit-profile"
          options={{
            presentation: "formSheet",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
            sheetAllowedDetents: [0.55, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="shortcuts"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="invite"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="notifications"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="new-idea"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="teams"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="archived-ideas"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="upgrade-account"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="team-apps"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="new-team-app"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="team-app-detail"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="shortcut-web"
          options={{
            presentation: "fullScreenModal",
            headerShown: false,
            animation: "slide_from_right",
            gestureEnabled: true,
          }}
        />
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  layout: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
