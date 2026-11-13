import { invoke } from '@tauri-apps/api/core'

export type SafeSaveFilter = {
  name: string
  extensions: string[]
}

export type SafeSaveOptions = {
  title?: string
  defaultPath?: string
  filters?: SafeSaveFilter[]
}

/**
 * Save dialog that cannot crash the desktop process.
 *
 * Prefer this over `@tauri-apps/plugin-dialog` `save()` on desktop. The plugin
 * path panics inside AppKit when `NSSavePanel` returns NULL (Sentry
 * TEAMCLU-RUST-10 / RUST-11); the Rust command catches that and returns Err.
 *
 * Returns `null` when the user cancels.
 */
export async function safeSaveDialog(options: SafeSaveOptions = {}): Promise<string | null> {
  return invoke<string | null>('safe_save_dialog', {
    args: {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    },
  })
}
