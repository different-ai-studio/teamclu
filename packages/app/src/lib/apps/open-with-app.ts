import { isTauri } from '@/lib/utils'

/**
 * The tools a local app checkout can be opened in. Ids match
 * `OpenWithTarget::parse` in `apps/desktop/src/commands/open_with_app.rs`; the
 * desktop decides what each one runs.
 */
export const OPEN_WITH_TARGETS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'workbuddy', label: 'WorkBuddy' },
] as const

export type OpenWithTargetId = (typeof OPEN_WITH_TARGETS)[number]['id']

/** Open a local folder with one of `OPEN_WITH_TARGETS`. Throws the desktop's error. */
export async function openPathWithApp(path: string, target: OpenWithTargetId): Promise<void> {
  if (!isTauri()) throw new Error('Only available in the desktop app')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_path_with_app', { path, target })
}
