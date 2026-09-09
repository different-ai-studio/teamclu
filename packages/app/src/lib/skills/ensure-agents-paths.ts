import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'
import { useAgentsSkillsAccessStore } from '@/stores/agents-skills-access-store'

/** Ensure ~/.agents/skills exists, is writable, and is registered in OpenCode + Claude skills.paths. */
export async function ensureAgentsSkillsPaths(workspacePath?: string | null): Promise<void> {
  if (!isTauri()) return
  await useAgentsSkillsAccessStore.getState().assertAccess()
  await invoke('ensure_agents_skills_paths', {
    workspacePath: workspacePath?.trim() || null,
  })
}
