// Telemetry-only per-install id. NOT a routing identity (routing uses actor_id).
// Lets two desktop installs of the same actor appear as separate version rows.
const KEY = "teamclu.client-version.device-id";

export function getDesktopDeviceId(): string {
  return getDesktopDeviceIdOrNull() ?? "desktop-unknown";
}

/**
 * The same id, but `null` instead of the shared "desktop-unknown" placeholder
 * when storage is unavailable.
 *
 * Telemetry can live with every unidentifiable install collapsing onto one
 * label. Anything that keys *state* on this id cannot: two machines that both
 * fall back would be handed the same row. Guest-team reuse is exactly that —
 * see AuthGate, which sends null rather than let strangers share a team.
 */
function getDesktopDeviceIdOrNull(): string | null {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return null;
  }
}
