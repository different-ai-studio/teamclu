import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { cloudAuth } from "../src/lib/auth/cloud-auth";
import { colors, spacing, typography } from "../src/ui/theme";

/**
 * Dev-only route. Loads `.dev-session.json` (gitignored, written by
 * `scripts/dev-session.sh` or a Supabase admin generate_link + verify
 * round-trip) and calls `cloudAuth.auth.setSession`. After the auth
 * state propagates, redirects to the sessions tab.
 *
 * If the file is missing or the bundle excludes it, the route bounces
 * to "/" instead of crashing.
 */
export default function DevSessionRoute() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "done" | "missing" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // require() is wrapped so we never crash the bundle if the file
        // is absent. Metro hoists statically-known requires, so we keep
        // this in a try and accept the lint warning.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const payload = require("../.dev-session.json");
        const { access_token, refresh_token } = payload;
        if (!access_token || !refresh_token) {
          if (!cancelled) setStatus("missing");
          return;
        }
        const { error } = await cloudAuth.auth.setSession({
          access_token,
          refresh_token,
        });
        if (cancelled) return;
        if (error) {
          setStatus("error");
          setMessage(error.message);
          return;
        }
        setStatus("done");
        setTimeout(() => router.replace("/(app)/sessions"), 200);
      } catch (err) {
        if (cancelled) return;
        setStatus("missing");
        setMessage(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (status === "done") {
    return <Redirect href="/(app)/sessions" />;
  }

  return (
    <View style={styles.screen}>
      {status === "loading" ? (
        <View style={styles.row}>
          <ActivityIndicator color={colors.slate} />
          <Text style={styles.body}>Restoring dev session…</Text>
        </View>
      ) : null}
      {status === "missing" ? (
        <Text style={styles.body}>
          No .dev-session.json bundled. Generate one with the Supabase
          admin API, drop it next to package.json, and hot-reload.
        </Text>
      ) : null}
      {status === "error" ? (
        <Text style={styles.body}>setSession error: {message}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.onyx,
    textAlign: "center",
    ...typography.body,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  screen: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
  },
});
