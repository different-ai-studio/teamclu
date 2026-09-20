import { extensionTeamOnboarding } from '@/lib/config/build-config'

/**
 * Extension-only team bootstrap (`extensions.teamOnboarding.autoCreateTeam`).
 * Desktop / web builds always allow the normal first-team flow.
 */
export function isExtensionAutoCreateTeamEnabled(): boolean {
  if (import.meta.env.VITE_FORCE_EMBED !== 'chat') return true
  return extensionTeamOnboarding.autoCreateTeam !== false
}
