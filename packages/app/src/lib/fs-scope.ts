/**
 * Widening the webview's filesystem scope at runtime (SEC-2 / ADR-0009).
 *
 * `apps/desktop/capabilities/default.json` no longer grants `$HOME/**` + `/**`.
 * It statically covers only the two fixed skill roots; the brand's amuxd home
 * is granted by Rust at startup, and everything the user opens has to be
 * granted as it is opened.
 *
 * Most of that needs nothing from us — Tauri's dialog plugin grants whatever
 * the user picks in an open/save dialog, and its drag-drop handler grants
 * dropped paths before the event even reaches the frontend. This module is for
 * the paths the *frontend* knows first: the workspace (from `localStorage`) and
 * the extra role/skill scan directories (from a config file we parse).
 *
 * Grants live in memory and do not survive a restart, so they must be re-made
 * on each launch, before the first read — not lazily on failure.
 */

import { isTauri } from "@/lib/utils"

/**
 * Ask Rust to widen the fs scope to these directories and everything under
 * them. Never throws: if the grant fails, the fs calls that needed it report
 * their own errors, which says more about what actually broke than a failure
 * here would.
 */
export async function allowFsScopeDirs(paths: string[]): Promise<void> {
  if (!isTauri()) return
  const wanted = paths.filter((p) => p.trim().length > 0)
  if (wanted.length === 0) return
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("allow_fs_scope_dirs", { paths: wanted })
  } catch (error) {
    console.warn("[FsScope] Failed to widen fs scope:", error)
  }
}
