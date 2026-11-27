import { invoke } from '@tauri-apps/api/core'

export type SafeOpenFilter = {
  name: string
  extensions: string[]
}

export type SafeOpenOptions = {
  title?: string
  defaultPath?: string
  filters?: SafeOpenFilter[]
  directory?: boolean
  multiple?: boolean
}

/**
 * Open dialog (files or folders) that cannot crash the desktop process.
 *
 * Use this instead of `@tauri-apps/plugin-dialog` `open()` on desktop. The
 * plugin path panics inside AppKit when `+[NSOpenPanel openPanel]` returns
 * NULL, and its async waiter then dies on `RecvError` (Sentry TEAMCLU-RUST-15
 * through RUST-18). The Rust command catches that and rejects instead.
 *
 * Same return shape as the plugin's `open()`: `null` on cancel, a string when
 * `multiple` is false, an array of strings when it is true.
 */
export async function safeOpenDialog(
  options: SafeOpenOptions & { multiple: true },
): Promise<string[] | null>
export async function safeOpenDialog(
  options?: SafeOpenOptions & { multiple?: false },
): Promise<string | null>
export async function safeOpenDialog(
  options: SafeOpenOptions = {},
): Promise<string | string[] | null> {
  const paths = await invoke<string[] | null>('safe_open_dialog', {
    args: {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      directory: options.directory ?? false,
      multiple: options.multiple ?? false,
    },
  })
  if (!paths || paths.length === 0) return null
  return options.multiple ? paths : paths[0]
}
