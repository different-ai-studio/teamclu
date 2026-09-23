import { Redirect } from "expo-router";

/**
 * The Voice tab is an action, not a place — its tab press opens the
 * `voice-capture` modal instead of selecting this route (see the tabs layout).
 * Should anything navigate here anyway (a deep link, a restored state), bounce
 * to Sessions rather than strand the user on an empty tab, as iOS does.
 */
export default function VoiceTabRoute() {
  return <Redirect href="/(app)/sessions" />;
}
