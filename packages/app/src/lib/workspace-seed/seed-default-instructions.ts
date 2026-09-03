import { join } from '@tauri-apps/api/path'
import { exists, readDir, writeTextFile } from '@tauri-apps/plugin-fs'
import { TEAMCLU_DIR } from '@/lib/build-config'
import agentsTemplate from './AGENTS.default.md?raw'
import claudeTemplate from './CLAUDE.default.md?raw'

function folderNameFromPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || trimmed || path
}

/** Dir entries that do not count as “project content” for the empty-workspace check. */
const WORKSPACE_SEED_IGNORED_NAMES = new Set([
  '.git',
  '.gitignore',
  '.DS_Store',
  TEAMCLU_DIR,
])

type WorkspaceInstructionVars = {
  workspaceName: string
  teamName?: string | null
}

/**
 * Minimal mustache-ish renderer:
 * - `{{name}}` → string replace
 * - `{{#name}}...{{/name}}` kept only when truthy
 * - `{{^name}}...{{/name}}` kept only when falsy
 */
export function renderWorkspaceInstructionTemplate(
  template: string,
  vars: WorkspaceInstructionVars,
): string {
  const values: Record<string, string> = {
    workspaceName: vars.workspaceName,
    teamName: vars.teamName?.trim() || '',
  }

  let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) =>
    values[key] ? body : '',
  )
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) =>
    values[key] ? '' : body,
  )
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? '')
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

export function isNearlyEmptyWorkspace(entryNames: string[]): boolean {
  return entryNames.every((name) => WORKSPACE_SEED_IGNORED_NAMES.has(name))
}

type SeedDefaultWorkspaceInstructionsOptions = {
  teamName?: string | null
  workspaceName?: string
}

/**
 * Seed root `AGENTS.md` / `CLAUDE.md` for a nearly empty workspace.
 * Missing files only — never overwrites. No-ops on non-empty trees.
 */
export async function seedDefaultWorkspaceInstructions(
  workspacePath: string,
  options: SeedDefaultWorkspaceInstructionsOptions = {},
): Promise<void> {
  try {
    const entries = await readDir(workspacePath)
    const names = entries
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)

    if (!isNearlyEmptyWorkspace(names)) {
      return
    }

    const workspaceName =
      options.workspaceName?.trim() || folderNameFromPath(workspacePath)

    const vars: WorkspaceInstructionVars = {
      workspaceName,
      teamName: options.teamName,
    }

    const files: Array<{ name: string; template: string }> = [
      { name: 'AGENTS.md', template: agentsTemplate },
      { name: 'CLAUDE.md', template: claudeTemplate },
    ]

    for (const file of files) {
      const path = await join(workspacePath, file.name)
      if (await exists(path)) continue
      const content = renderWorkspaceInstructionTemplate(file.template, vars)
      await writeTextFile(path, content)
    }
  } catch (error) {
    console.warn('[WorkspaceSeed] Failed to seed default instructions:', error)
  }
}
