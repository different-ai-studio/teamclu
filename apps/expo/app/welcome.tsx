import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";

import {
  createIntroFlagStore,
  resolveSignedOutEntry,
  type SignedOutEntry,
} from "../src/features/onboarding/onboarding-intent";
import { loadPendingInviteToken } from "../src/features/onboarding/pending-invite";
import { IntroScreen } from "../src/features/onboarding/screens/IntroScreen";

import { routeToHref, useOnboarding } from "./_layout";

const introFlag = createIntroFlagStore();

/**
 * Signed-out root (`route == needsAuth`). Port of iOS `WelcomeView`:
 *   - holding an invite link → straight to sign-in; the claim runs after
 *   - first install → the intro cards, then the join/create choice
 *   - later (after sign-out, a revoked session) → straight to the choice
 */
export default function WelcomeRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();
  const [entry, setEntry] = useState<SignedOutEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([introFlag.hasSeen(), loadPendingInviteToken()]).then(
      async ([hasSeenIntro, pendingInvite]) => {
        const next = resolveSignedOutEntry({
          hasSeenIntro,
          hasPendingInvite: pendingInvite !== null,
        });
        // Someone who opened an invite link is joining: a claim that fails
        // after sign-in lands on the no-team screen, not a fresh team.
        if (next === "invitedLogin") await controller.setIntent("join");
        if (!cancelled) setEntry(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller]);

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  if (entry === null) return null;
  if (entry === "invitedLogin") return <Redirect href="/auth?invited=1" />;
  if (entry === "choice") return <Redirect href="/choose-auth" />;

  return (
    <IntroScreen
      onFinish={() => {
        void introFlag.markSeen();
        router.replace("/choose-auth");
      }}
    />
  );
}
