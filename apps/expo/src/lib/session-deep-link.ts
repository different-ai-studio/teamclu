/**
 * `teamclu://session/<id>` — what Share in a session sends, and what iOS opens
 * (`AMUXApp.handle(_:)` → `.amuxOpenSession`). No Expo route matched it, so a
 * shared link opened the app on whatever screen it was last on.
 *
 * Returns the in-app route for a session link, or null for anything else. Takes
 * either the full URL or the bare path expo-router passes to
 * `redirectSystemPath`.
 */
const SCHEMES = new Set(["teamclu", "teamclaw", "amux"]);

export function sessionRouteForLink(link: string | null | undefined): string | null {
  const raw = (link ?? "").trim();
  if (!raw) return null;

  let segments: string[];
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (schemeMatch) {
    if (!SCHEMES.has(schemeMatch[1].toLowerCase())) return null;
    segments = schemeMatch[2].split(/[?#]/)[0].split("/");
  } else {
    segments = raw.split(/[?#]/)[0].split("/");
  }
  segments = segments.filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "session") return null;

  const id = decodeURIComponent(segments[1]);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return `/(app)/sessions/${encodeURIComponent(id)}`;
}
