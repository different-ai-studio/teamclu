import { extensionSoloBuild } from '@/lib/config/build-config'

/**
 * Solo-agent extension build (`extensions.solo` in build.config*.json).
 * Only applies to extension embed packs (`VITE_FORCE_EMBED=chat`).
 * Hides permission control + model on mention pills; forces narrow layout.
 */
export function isSoloBuild(): boolean {
  if (import.meta.env.VITE_FORCE_EMBED !== 'chat') return false
  return extensionSoloBuild
}
