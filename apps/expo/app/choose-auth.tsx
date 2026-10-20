import { Redirect, useRouter } from "expo-router";

import { savePendingInviteToken } from "../src/features/onboarding/pending-invite";
import { OnboardingChoiceScreen } from "../src/features/onboarding/screens/OnboardingChoiceScreen";

import { routeToHref, useOnboarding } from "./_layout";

/** The join / create fork before sign-in. iOS `OnboardingChoiceView`. */
export default function ChooseAuthRoute() {
  const router = useRouter();
  const { controller, state, applyServerChange } = useOnboarding();

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <OnboardingChoiceScreen
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      onServerChanged={applyServerChange}
      onJoin={() => {
        void controller.setIntent("join").then(() => router.push("/auth"));
      }}
      onCreate={() => {
        void controller
          .setIntent("create")
          .then(() => router.push("/desktop-guide?mode=beforeSignIn"));
      }}
      onInviteToken={async (token) => {
        // Sign in first; the claim runs as that account once the route is
        // signed in (RootLayout's pending-invite effect). Member invites
        // cannot be claimed without a real account.
        await savePendingInviteToken(token);
        await controller.setIntent("join");
        router.push("/auth?invited=1");
      }}
    />
  );
}
