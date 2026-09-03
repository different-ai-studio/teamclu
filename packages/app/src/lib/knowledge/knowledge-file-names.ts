/**
 * Whether `name` already ends in something that reads as a file extension.
 *
 * Deliberately narrow: the last dot must be followed by 1–8 ASCII
 * alphanumerics and nothing else. Knowledge documents are routinely named
 * things like `v1.2 计划` or `2026.03 复盘`, and treating "2 计划" as an
 * extension would leave them without `.md` — invisible to Obsidian, which is
 * the whole problem this is fixing.
 */
function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file (`.gitignore`), not an extension.
  if (dot <= 0) return false
  return /^[A-Za-z0-9]{1,8}$/.test(name.slice(dot + 1))
}

/**
 * Give a new file the default extension when the user did not type one.
 *
 * Used for documents created in the team knowledge tree, where the default is
 * `.md`: a file with no extension is not a note to Obsidian — it cannot open
 * it, and hides it entirely unless `showUnsupportedFiles` is on. An explicit
 * extension is always respected, so attachments (`diagram.png`) still work.
 *
 * Returns `name` unchanged when it is empty or already carries an extension.
 */
export function withDefaultExtension(name: string, extension: string): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  // A dotfile is configuration, not a document. `.gitignore.md` helps nobody.
  if (trimmed.startsWith('.')) return trimmed
  if (hasExtension(trimmed)) return trimmed
  return `${trimmed}${extension}`
}

/** Default extension for documents in the team knowledge tree. */
export const KNOWLEDGE_DEFAULT_EXTENSION = '.md'
