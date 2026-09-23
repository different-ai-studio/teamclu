import { Redirect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { NoTeamScreen } from "../src/features/onboarding/screens/NoTeamScreen";
import { supabase } from "../src/lib/supabase/client";

import { routeToHref, useOnboarding } from "./_layout";

/** `route == noTeam`: signed in, no team, and joining one. iOS `NoTeamView`. */
export default function NoTeamRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();
  const [email, setEmail] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const isNoTeam = state.route === "noTeam";

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      await controller.refreshNoTeam();
    } finally {
      refreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [controller]);

  useEffect(() => {
    if (!isNoTeam) return;
    let cancelled = false;
    void controller.refreshPendingInvites();
    void supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setEmail(data.user?.email ?? null);
    });
    // Back from the mail app / a chat with the invite: check again.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [controller, isNoTeam, refresh]);

  if (!isNoTeam) {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <NoTeamScreen
      email={email}
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      isRefreshing={isRefreshing}
      pendingInvites={state.pendingInvites}
      onAcceptInvite={(invite) => {
        void controller.acceptPendingInvite(invite.id).catch(() => {});
      }}
      onCreateInstead={() => router.push("/desktop-guide?mode=signedIn")}
      onJoinWithToken={(token) => controller.joinWithInvite(token)}
      onRefresh={() => {
        void refresh();
      }}
      onSwitchAccount={() => {
        void controller.signOut().catch(() => {});
      }}
    />
  );
}
