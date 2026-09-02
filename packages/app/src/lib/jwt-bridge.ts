// ---------------------------------------------------------------------------
// JWT bridge — historically pushed the Supabase access_token into teamclu.json
// via the desktop `oss_sync_set_jwt` command so the Rust FC commands could
// authenticate to FC.
//
// The desktop backend now proxies team-sync to the amuxd daemon, and the daemon
// self-supplies its own FC JWT. The `oss_sync_set_jwt` command was deleted, so
// there is nothing for this bridge to write anymore.
//
// `initJwtBridge()` and `ensureJwtSynced()` are kept as no-ops so their existing
// callers (main.tsx startup, team-share store, TeamSharedLlmPane) continue to
// compile and call them harmlessly. They can be removed entirely in a later
// pass once every caller has been audited.
// ---------------------------------------------------------------------------

/**
 * No-op. The daemon now supplies its own FC JWT; the desktop no longer writes a
 * token into teamclu.json. Kept for call-site compatibility with main.tsx.
 */
export function initJwtBridge(): void {
  // intentionally empty — see module header.
}

