import { create } from 'zustand'

import {
  assertAgentsSkillsAccess,
  checkAgentsSkillsAccess,
  type AgentsSkillsAccess,
  isAgentsSkillsAccessError,
} from '@/lib/skills/agents-skills-access'
import { isTauri } from '@/lib/utils'

interface AgentsSkillsAccessState {
  access: AgentsSkillsAccess | null
  checking: boolean
  dismissed: boolean
  /** Run the probe; updates banner state. Returns whether access is ok. */
  check: () => Promise<boolean>
  /**
   * Same as check, but throws AgentsSkillsAccessError when blocked so install
   * callers can abort. Also refreshes the startup banner.
   */
  assertAccess: () => Promise<AgentsSkillsAccess>
  dismiss: () => void
  /** Clear a prior dismiss so a failed install resurfaces the banner. */
  showBlocked: (access: AgentsSkillsAccess) => void
}

export const useAgentsSkillsAccessStore = create<AgentsSkillsAccessState>((set, get) => ({
  access: null,
  checking: false,
  dismissed: false,

  check: async () => {
    if (!isTauri()) {
      set({
        access: {
          path: '~/.agents/skills',
          ok: true,
          kind: 'ok',
          message: 'ok',
          osReadable: true,
          osWritable: true,
          scopeGranted: true,
        },
        checking: false,
        dismissed: false,
      })
      return true
    }
    set({ checking: true })
    try {
      const access = await checkAgentsSkillsAccess()
      set({
        access,
        checking: false,
        dismissed: access.ok ? false : get().dismissed,
      })
      return access.ok
    } catch (err) {
      const access: AgentsSkillsAccess = {
        path: '~/.agents/skills',
        ok: false,
        kind: 'create_failed',
        message: err instanceof Error ? err.message : String(err),
        osReadable: false,
        osWritable: false,
        scopeGranted: false,
      }
      set({ access, checking: false })
      return false
    }
  },

  assertAccess: async () => {
    try {
      const access = await assertAgentsSkillsAccess()
      set({ access, dismissed: false })
      return access
    } catch (err) {
      if (isAgentsSkillsAccessError(err)) {
        get().showBlocked(err.access)
      }
      throw err
    }
  },

  dismiss: () => set({ dismissed: true }),

  showBlocked: (access) => set({ access, dismissed: false }),
}))
