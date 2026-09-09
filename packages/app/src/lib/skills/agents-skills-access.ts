import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

export type AgentsSkillsAccessKind =
  | 'ok'
  | 'home_missing'
  | 'create_failed'
  | 'os_permission'
  | 'tauri_scope'

export interface AgentsSkillsAccess {
  path: string
  ok: boolean
  kind: AgentsSkillsAccessKind
  message: string
  osReadable: boolean
  osWritable: boolean
  scopeGranted: boolean
}

export class AgentsSkillsAccessError extends Error {
  readonly access: AgentsSkillsAccess

  constructor(access: AgentsSkillsAccess) {
    super(access.message || 'Cannot access ~/.agents/skills')
    this.name = 'AgentsSkillsAccessError'
    this.access = access
  }
}

export function isAgentsSkillsAccessError(err: unknown): err is AgentsSkillsAccessError {
  return err instanceof AgentsSkillsAccessError
}

/** Probe OS + Tauri scope for ~/.agents/skills. No-op (ok) outside Tauri. */
export async function checkAgentsSkillsAccess(): Promise<AgentsSkillsAccess> {
  if (!isTauri()) {
    return {
      path: '~/.agents/skills',
      ok: true,
      kind: 'ok',
      message: 'ok',
      osReadable: true,
      osWritable: true,
      scopeGranted: true,
    }
  }
  return invoke<AgentsSkillsAccess>('check_agents_skills_access')
}

/**
 * Ensure the shared skills root is readable/writable and in the webview fs
 * scope. Throws {@link AgentsSkillsAccessError} when blocked so callers can
 * surface reveal-in-Finder + retry UI.
 */
export async function assertAgentsSkillsAccess(): Promise<AgentsSkillsAccess> {
  const access = await checkAgentsSkillsAccess()
  if (!access.ok) {
    throw new AgentsSkillsAccessError(access)
  }
  return access
}
