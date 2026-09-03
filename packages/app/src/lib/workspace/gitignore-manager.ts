import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { buildConfig, TEAMCLU_DIR } from '@/lib/config/build-config'

/**
 * Default entries that should be in workspace .gitignore
 */
const TEAMCLU_GITIGNORE_ENTRIES = [
  `# ${buildConfig.app.name} system directories`,
  `${TEAMCLU_DIR}/`,
  // Machine-local runtime config, not project content: the daemon materializes
  // it per machine (absolute binary paths, a local introspect port), so a
  // committed copy is churn at best and, on pre-#742 installs, a provider API
  // key in the history at worst.
  //
  // Note for an existing repo: git keeps tracking a file it already tracks —
  // `git rm --cached opencode.json` is what actually stops it.
  'opencode.json',
]

/**
 * Parse gitignore content into array of lines
 */
export function parseGitignore(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Check if an entry already exists in gitignore (handles exact match and variations)
 */
function hasEntry(lines: string[], entry: string): boolean {
  const normalizedEntry = entry.replace(/\/$/, '') // Remove trailing slash for comparison
  return lines.some(line => {
    const normalizedLine = line.replace(/\/$/, '')
    return normalizedLine === normalizedEntry || normalizedLine === entry
  })
}

/**
 * Ensure .gitignore contains required TeamClu entries
 * Creates .gitignore if it doesn't exist, or appends missing entries
 */
export async function ensureGitignoreEntries(workspacePath: string): Promise<void> {
  try {
    const gitignorePath = await join(workspacePath, '.gitignore')

    const gitignoreExists = await exists(gitignorePath)

    if (!gitignoreExists) {
      // Create new .gitignore with entries
      const content = TEAMCLU_GITIGNORE_ENTRIES.join('\n') + '\n'
      await writeTextFile(gitignorePath, content)
      console.log('[Gitignore] Created .gitignore with TeamClu entries')
      return
    }

    // Read existing .gitignore
    const existingContent = await readTextFile(gitignorePath)
    const lines = parseGitignore(existingContent)

    // Find missing entries
    const missingEntries = TEAMCLU_GITIGNORE_ENTRIES.filter(entry =>
      !entry.startsWith('#') && !hasEntry(lines, entry)
    )

    if (missingEntries.length === 0) {
      console.log('[Gitignore] All entries already present')
      return
    }

    // Append missing entries with comment header
    let newContent = existingContent
    if (!existingContent.endsWith('\n')) {
      newContent += '\n'
    }
    // Only when it isn't already there. This used to be written unconditionally,
    // which went unnoticed while there was a single entry — the workspace
    // metadata directory, spelled by buildConfig, not here: every
    // workspace already had it, so the append path never ran. Adding a second
    // entry made every existing workspace take it — and get a second copy of the
    // header stapled above the new line.
    const header = `# ${buildConfig.app.name} system directories`
    if (!hasEntry(lines, header)) {
      newContent += `\n${header}\n`
    } else {
      newContent += '\n'
    }
    newContent += missingEntries.join('\n') + '\n'

    await writeTextFile(gitignorePath, newContent)
    console.log('[Gitignore] Added missing entries:', missingEntries)
  } catch (error) {
    console.error('[Gitignore] Failed to ensure gitignore entries:', error)
  }
}
