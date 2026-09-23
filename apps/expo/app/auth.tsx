import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";

import { OAUTH_REDIRECT_URL } from "../src/features/onboarding/onboarding-oauth";
import { AuthScreen } from "../src/features/onboarding/screens/AuthScreen";
import { cloudApiBaseUrl } from "../src/lib/cloud-api/client";
import {
  FAIL_OPEN_AUTH_FLAGS,
  fetchPublicConfig,
  type PublicAuthFlags,
} from "../src/lib/cloud-api/public-config";

import { routeToHref, useOnboarding } from "./_layout";

WebBrowser.maybeCompleteAuthSession();

export default function AuthRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();
  const { invited } = useLocalSearchParams<{ invited?: string }>();
  // Starts fail-open so a slow network never strips sign-in buttons; the
  // server's answer replaces it as soon as it lands. An answer with no auth
  // block keeps fail-open too (iOS `PublicAuthFlags.fetch` returns nil there).
  const [authFlags, setAuthFlags] = useState<PublicAuthFlags>(FAIL_OPEN_AUTH_FLAGS);

  useEffect(() => {
    let cancelled = false;
    let base: string;
    try {
      base = cloudApiBaseUrl();
    } catch {
      return;
    }
    void fetchPublicConfig(base).then((config) => {
      if (!cancelled && config?.authFlags) setAuthFlags(config.authFlags);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <AuthScreen
      authFlags={authFlags}
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      pendingEmail={state.pendingEmailOTPEmail}
      pendingPhone={state.pendingPhoneOTPPhone}
      phoneAccounts={state.phoneAccounts}
      showInviteNotice={invited === "1"}
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace("/choose-auth");
        }
      }}
      onDismissPhoneAccounts={controller.dismissPhoneAccounts}
      onRequestOtp={controller.requestOtp}
      onRequestPhoneOtp={controller.requestPhoneOtp}
      onResetPendingEmail={controller.resetPendingEmail}
      onResetPendingPhone={controller.resetPendingPhone}
      onSelectPhoneAccount={(account) => controller.selectPhoneAccount(account.id)}
      onSignInWithApple={() =>
        controller.signInWithOAuth("apple", {
          redirectTo: OAUTH_REDIRECT_URL,
          openAuthSession: WebBrowser.openAuthSessionAsync,
        })
      }
      onSignInWithGoogle={() =>
        controller.signInWithOAuth("google", {
          redirectTo: OAUTH_REDIRECT_URL,
          openAuthSession: WebBrowser.openAuthSessionAsync,
        })
      }
      onSignInWithPassword={controller.signInWithPassword}
      onVerifyOtp={controller.verifyOtp}
      onVerifyPhoneOtp={controller.verifyPhoneOtp}
    />
  );
}
