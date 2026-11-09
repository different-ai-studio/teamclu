import { useEffect, useState } from "react";
import { getBackend, hasBackendConfig } from "@/lib/backend";
import type { PlatformWhoami } from "@/lib/backend/types";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Whether the signed-in user runs the deployment this client points at.
 *
 * Operator screens are hidden unless this says yes — and hiding them is all it
 * decides. Every operator endpoint checks the caller again on the server, so a
 * stale or forged `true` here reveals nothing.
 *
 * A successful answer is cached per signed-in user for the life of the
 * process. Per user, because one process changes accounts: an operator who
 * enters a customer org through support mode is signed in as that org's
 * support account, which is not an operator. A FAILURE is deliberately not
 * cached — being offline or signed out at the moment of the first call would
 * otherwise hide the screens for the rest of the session.
 */
// Keyed by the signed-in user id at the time of asking ("" before the auth
// store knows one).
let cached: { key: string; who: PlatformWhoami } | null = null;
let inflight: { key: string; promise: Promise<PlatformWhoami | null> } | null = null;

export function resetPlatformOperatorCacheForTests(): void {
  cached = null;
  inflight = null;
}

function cacheKey(): string {
  return useAuthStore.getState().session?.user?.id ?? "";
}

function cachedFor(key: string): PlatformWhoami | null {
  return cached && cached.key === key ? cached.who : null;
}

export async function loadWhoami(): Promise<PlatformWhoami | null> {
  if (!hasBackendConfig()) return null;
  const key = cacheKey();
  const hit = cachedFor(key);
  if (hit) return hit;
  if (inflight?.key === key) return inflight.promise;
  const promise: Promise<PlatformWhoami | null> = (async () => {
    try {
      const who = await getBackend().admin.whoami();
      // Cache only if the account did not change while this was in flight.
      if (cacheKey() === key) cached = { key, who };
      return who;
    } catch {
      // 401 before sign-in, or a Cloud API too old to have the route. Either
      // way the user is not an operator, and it is worth asking again later.
      return null;
    } finally {
      if (inflight?.key === key) inflight = null;
    }
  })();
  inflight = { key, promise };
  return promise;
}

export function usePlatformOperator(): {
  loading: boolean;
  operator: boolean;
  /** The caller's own user id. */
  userId: string | null;
} {
  const key = useAuthStore((s) => s.session?.user?.id ?? "");
  const [whoami, setWhoami] = useState<PlatformWhoami | null>(() => cachedFor(key));
  const [loading, setLoading] = useState(() => !cachedFor(key));

  useEffect(() => {
    let alive = true;
    const hit = cachedFor(key);
    setWhoami(hit);
    setLoading(!hit);
    void loadWhoami().then((who) => {
      if (!alive) return;
      setWhoami(who);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return { loading, operator: whoami?.operator ?? false, userId: whoami?.userId ?? null };
}
