import { sessionRouteForLink } from "../src/lib/session-deep-link";

/**
 * Rewrites system links before expo-router matches them — cold and warm
 * launches both pass through here. Only session links are rewritten; invites
 * and the OAuth callback keep their own handling in `_layout.tsx`.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return sessionRouteForLink(path) ?? path;
}
