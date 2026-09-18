import { useEffect, useState } from "react";
import { getBackend, hasBackendConfig } from "@/lib/backend";
import type { PlatformWhoami } from "@/lib/backend/types";

/**
 * Whether the signed-in user runs the deployment this client points at.
 *
 * Operator screens are hidden unless this says yes — and hiding them is all it
 * decides. Every operator endpoint checks the caller again on the server, so a
 * stale or forged `true` here reveals nothing.
 *
 * A successful answer is cached for the life of the process: it comes from the
 * deployment's environment, which cannot change without restarting the Cloud
 * API. A FAILURE is deliberately not cached — being offline or signed out at
 * the moment of the first call would otherwise hide the screens for the rest
 * of the session.
 */
let cached: PlatformWhoami | null = null;
let inflight: Promise<PlatformWhoami | null> | null = null;

export function resetPlatformOperatorCacheForTests(): void {
  cached = null;
  inflight = null;
}

async function loadWhoami(): Promise<PlatformWhoami | null> {
  if (cached) return cached;
  if (!hasBackendConfig()) return null;
  inflight ??= (async () => {
    try {
      cached = await getBackend().admin.whoami();
      return cached;
    } catch {
      // 401 before sign-in, or a Cloud API too old to have the route. Either
      // way the user is not an operator, and it is worth asking again later.
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function usePlatformOperator(): {
  loading: boolean;
  operator: boolean;
  /** The caller's own user id, which is what PLATFORM_OPERATOR_USER_IDS lists. */
  userId: string | null;
} {
  const [whoami, setWhoami] = useState<PlatformWhoami | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    let alive = true;
    void loadWhoami().then((who) => {
      if (!alive) return;
      setWhoami(who);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { loading, operator: whoami?.operator ?? false, userId: whoami?.userId ?? null };
}
