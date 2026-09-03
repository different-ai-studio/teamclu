import i18n from '@/lib/i18n'

/**
 * Map raw FC/Tauri command errors into friendly, user-facing copy.
 *
 * The Rust commands surface low-level strings like
 * "supabase_jwt not found — user not logged in" when the Supabase JWT has not
 * been written into teamclu.json yet. That string should never reach the UI —
 * show a sign-in prompt instead. Returns null for the not-logged-in case so
 * callers can decide to render a softer state rather than a red error.
 */
export function humanizeFcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (isNotLoggedInError(raw)) {
    return i18n.t('errors.loginRequired')
  }
  if (/disable_team_share RPC is missing|PGRST202/i.test(raw)) {
    return i18n.t('settings.team.disconnectMigrationRequired')
  }
  if (/schema_drift/i.test(raw)) {
    return i18n.t('settings.team.disconnectSchemaDrift')
  }
  return raw
}

/** True when the error means "no Supabase JWT / not signed in". */
export function isNotLoggedInError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  return /not logged in|supabase_jwt/i.test(raw)
}
