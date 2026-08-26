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
   * The directory carries a `.obsidian/` folder, so Obsidian has opened it as a
   * vault before. Until then `obsidian://open?path=` cannot resolve it and the
   * user has to add the folder as a vault once.
   */
  vaultInitialized: boolean
}

/** Not installed, no vault — what every non-desktop caller gets. */
export const OBSIDIAN_ABSENT: ObsidianStatus = { installed: false, vaultInitialized: false }

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
 * Open `vaultPath` in Obsidian.
 *
 * When the directory has never been opened as a vault the backend launches
 * Obsidian without a target instead — the URI would resolve to nothing and the
 * user would get an error dialog. Callers should check `vaultInitialized` and
 * tell the user what to do in that case.
 *
 * Rejects with the backend's message so the caller can surface a real failure
 * rather than a silent no-op.
 */
export async function openVaultInObsidian(vaultPath: string): Promise<void> {
  if (!isTauri()) throw new Error('obsidian: desktop only')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('obsidian_open_vault', { vaultPath })
}
