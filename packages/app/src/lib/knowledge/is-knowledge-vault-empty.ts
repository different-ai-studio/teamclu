/**
 * Whether the team's knowledge vault still needs a first-time scaffold CTA.
 *
 * "Empty" means no real files under `knowledge/` — empty directories from
 * `ensure_initialized` do not count. Dotfiles / `.conflicts` / `.obsidian` /
 * `.DS_Store` are ignored so a freshly linked machine is not treated as
 * already initialized.
 */

const IGNORED_NAMES = new Set(['.conflicts', '.obsidian', '.DS_Store', 'Thumbs.db'])

function shouldIgnore(name: string): boolean {
  if (IGNORED_NAMES.has(name)) return true
  // Other AppleDouble / editor noise that is not vault content.
  if (name.startsWith('._')) return true
  return false
}

export async function isKnowledgeVaultEmpty(syncRoot: string): Promise<boolean> {
  const { exists, readDir } = await import('@tauri-apps/plugin-fs')
  const vault = `${syncRoot.replace(/[/\\]+$/, '')}/knowledge`
  if (!(await exists(vault))) return true

  async function hasFile(dir: string): Promise<boolean> {
    let entries
    try {
      entries = await readDir(dir)
    } catch {
      return false
    }
    for (const entry of entries) {
      const name = entry.name
      if (!name || shouldIgnore(name)) continue
      if (entry.isDirectory) {
        if (await hasFile(`${dir}/${name}`)) return true
      } else if (entry.isFile) {
        return true
      }
    }
    return false
  }

  return !(await hasFile(vault))
}
