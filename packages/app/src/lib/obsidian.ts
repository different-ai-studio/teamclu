import { isTauri } from '@/lib/utils'

/**
 * Whether Obsidian can be used from here, and whether this directory is a vault
 * it already knows. Mirrors `ObsidianStatus` in
 * `apps/desktop/src/commands/obsidian.rs`.
 */
export interface ObsidianStatus {
  /** Obsidian is installed on this machine. */
  installed: boolean
  /**
   * The directory is in Obsidian's vault registry, so `obsidian://open?path=`
   * resolves it. When false, the first open registers it first.
   */
  vaultRegistered: boolean
}

/**
 * What an open actually managed to do. Mirrors `OpenOutcome` in the backend.
 *
 * `registeredNeedsRestart` exists because Obsidian reads its vault registry at
 * startup only — a vault registered while it is running is invisible to it
 * until the next launch.
 */
export type ObsidianOpenOutcome = 'opened' | 'registeredNeedsRestart'

/** Not installed, no vault — what every non-desktop caller gets. */
export const OBSIDIAN_ABSENT: ObsidianStatus = { installed: false, vaultRegistered: false }

/**
 * Ask the backend about Obsidian. Never throws: a probe that fails is reported
 * as "not installed", which greys the button out rather than breaking the
 * header it lives in.
 */
export async function getObsidianStatus(vaultPath: string | null): Promise<ObsidianStatus> {
  if (!isTauri()) return OBSIDIAN_ABSENT
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<ObsidianStatus>('obsidian_status', { vaultPath: vaultPath ?? '' })
  } catch {
    return OBSIDIAN_ABSENT
  }
}

/**
 * Open `vaultPath` in Obsidian, registering it as a vault on first use.
 *
 * Rejects with the backend's message so the caller can surface a real failure
 * rather than a silent no-op.
 */
export async function openVaultInObsidian(vaultPath: string): Promise<ObsidianOpenOutcome> {
  if (!isTauri()) throw new Error('obsidian: desktop only')
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<ObsidianOpenOutcome>('obsidian_open_vault', { vaultPath })
}
