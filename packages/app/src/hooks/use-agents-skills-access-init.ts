import { useEffect } from 'react'

import { isTauri } from '@/lib/utils'
import { useAgentsSkillsAccessStore } from '@/stores/agents-skills-access-store'

/** One-shot startup probe for ~/.agents/skills OS + Tauri scope access. */
export function useAgentsSkillsAccessInit() {
  useEffect(() => {
    if (!isTauri()) return
    void useAgentsSkillsAccessStore.getState().check()
  }, [])
}
