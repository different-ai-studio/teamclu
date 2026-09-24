import { Redirect, useLocalSearchParams, useRouter } from "expo-router";

import {
  DesktopGuideScreen,
  type DesktopGuideMode,
} from "../src/features/onboarding/screens/DesktopGuideScreen";

import { routeToHref, useOnboarding } from "./_layout";

/**
 * "Start a new team" → get the desktop app. Reached signed-out from the choice
 * screen (continue → sign in) or signed-in from the no-team screen (continue →
 * create the team).
 */
export default function DesktopGuideRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: DesktopGuideMode = params.mode === "signedIn" ? "signedIn" : "beforeSignIn";
  const expectedRoute = mode === "signedIn" ? "noTeam" : "needsAuth";

  if (state.route !== expectedRoute) {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace(mode === "signedIn" ? "/no-team" : "/choose-auth");
  };

  return (
    <DesktopGuideScreen
      errorMessage={mode === "signedIn" ? state.errorMessage : null}
      isBusy={state.isBusy}
      mode={mode}
      onBack={back}
      onContinue={() => {
        if (mode === "beforeSignIn") {
          router.push("/auth");
          return;
        }
        // The route change to `createTeam` redirects away from here.
        void controller.createTeamFromNoTeam();
      }}
    />
  );
}
