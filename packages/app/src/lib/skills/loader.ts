import { readDir, readTextFile, exists } from '@tauri-apps/plugin-fs'
import { collectTeamSkillPaths } from '@/lib/team-skill-paths'
import { frontmatterString } from '@/lib/skills/frontmatter'
import { homeDir } from '@tauri-apps/api/path'
import type { SkillWithSource, SkillSource } from './types'
import { INHERENT_SKILL_NAMES, shouldIncludeDesktopControlSkill } from './types'
import { appDisplayName } from '@/lib/build-config'
import i18n from '@/lib/i18n'

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract skill name from SKILL.md content (frontmatter or heading).
 *
 * Frontmatter goes through the shared parser rather than a regex: block
 * scalars (`when_not_to_use: |`) truncate at the first newline under the old
 * `/^---\n[\s\S]*?name:\s*(.+?)\n/` approach, and the daemon reads the same
 * files with the Rust twin of that parser.
 */
function extractSkillName(content: string, fallback: string): string {
  const name = frontmatterString(content, 'name')
  if (name) return name
  const firstLine = content.split('\n').find(line => line.startsWith('#'))
  if (firstLine) {
    return firstLine.replace(/^#+\s*/, '').trim()
  }
  return fallback
}

function getLastPathSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

export function buildSkillInvocationName(parentDir: string, filename: string): string {
  const scope = getLastPathSegment(parentDir)
  return scope && scope !== 'skills' ? `${scope}/${filename}` : filename
}

/** Load skills from a single directory, recording the directory path on each skill */
async function loadSkillsFromDir(
  dirPath: string,
  source: SkillSource,
): Promise<SkillWithSource[]> {
  const skills: SkillWithSource[] = []

  const tryLoadSkill = async (skillRoot: string, skillDirName: string, parentDir: string) => {
    const skillMdPath = `${skillRoot}/SKILL.md`
    if (!(await exists(skillMdPath))) return false

    const content = await readTextFile(skillMdPath)
    const name = extractSkillName(content, skillDirName)
    skills.push({
      filename: skillDirName,
      name,
      invocationName: buildSkillInvocationName(parentDir, skillDirName),
      content,
      source,
      dirPath: parentDir,
    })
    return true
  }

  try {
    if (!(await exists(dirPath))) return skills

    const entries = await readDir(dirPath)

    for (const entry of entries) {
      if (entry.isDirectory && entry.name) {
        try {
          const entryPath = `${dirPath}/${entry.name}`
          if (await tryLoadSkill(entryPath, entry.name, dirPath)) {
            continue
          }

          const nestedEntries = await readDir(entryPath)
          for (const nestedEntry of nestedEntries) {
            if (!nestedEntry.isDirectory || !nestedEntry.name) continue
            await tryLoadSkill(`${entryPath}/${nestedEntry.name}`, nestedEntry.name, entryPath)
          }
        } catch {
          console.warn(`[SkillLoader] Failed to load skill ${entry.name} from ${dirPath}`)
        }
      }
    }
  } catch {
    console.warn(`[SkillLoader] Cannot access ${dirPath}`)
  }

  return skills
}

// ─── Multi-Source Loader ────────────────────────────────────────────────────

export { collectTeamSkillPaths, readConfigSkillPaths } from '@/lib/team-skill-paths'

/**
 * Every skill directory scanned for the current workspace/user context, in the
 * daemon's resolution order — highest precedence first.
 *
 * The order is the one `skill_dir_specs` ranks by
 * (`apps/daemon/src/config/roles_skills.rs`), because it is what decides which
 * copy of a duplicated slug an agent actually loads. Callers that only need the
 * set (watchers, diagnostics) are unaffected by it; the skills column shows the
 * list to the user, where "which of these wins" is the whole point.
 */
export async function getSkillDirectories(workspacePath: string | null): Promise<string[]> {
  const home = trimTrailingPathSeparators(await homeDir())
  const dirs = new Set<string>()

  // rank 1
  if (workspacePath) dirs.add(`${workspacePath}/.claude/skills`)
  // rank 2 — ahead of the personal roots on purpose: this is where team packs
  // are installed, and a team skill is a team standard.
  dirs.add(`${home}/.agents/skills`)
  // rank 3
  if (workspacePath) dirs.add(`${workspacePath}/.agents/skills`)
  // rank 4
  if (workspacePath) {
    for (const dirPath of await collectTeamSkillPaths(workspacePath)) {
      dirs.add(dirPath)
    }
  }
  // rank 5
  dirs.add(`${home}/.claude/skills`)

  return Array.from(dirs)
}

/**
 * Load skills from all sources with priority-based merging.
 *
 * Kept in step with the daemon's `skill_dir_specs`, which is the list that
 * decides what an agent actually loads. Two loaders disagreeing about which
 * roots exist is how the settings page ends up showing a skill no runtime can
 * see (and hiding one it can).
 *
 * Workspace paths (project-level):
 * 1. `.claude/skills/`     → source: 'claude'
 * 2. `.agents/skills/`     → source: 'shared'
 *
 * Global paths (user-level):
 * 3. `~/.claude/skills/`          → source: 'global-claude'
 * 4. `~/.agents/skills/`          → source: 'global-agent'
 *
 * Dynamic paths (from `opencode.json` `skills.paths`):
 * 5+. Each configured path → source: 'team'
 *
 * Same-name skills are resolved by priority — workspace > global.
 */
export async function loadAllSkills(
  workspacePath: string | null,
): Promise<{
  skills: SkillWithSource[]
  overrides: Array<{ name: string; winner: SkillSource; loser: SkillSource }>
}> {
  const allSkills: SkillWithSource[] = []
  const overrides: Array<{ name: string; winner: SkillSource; loser: SkillSource }> = []

  const pushSkill = (skill: SkillWithSource) => {
    if (!shouldIncludeDesktopControlSkill(skill.filename)) return
    allSkills.push(skill)
  }

  // Get user home directory
  const home = await homeDir()

  // `builtin` is decided by name, not by root: the inherent skills are seeded
  // into `~/.agents/skills` and sit there next to team packs and the user's own
  // files. Applied at every root so a copy left behind by an older build reads
  // the same way.
  const labelled = (skill: SkillWithSource, isGlobal: boolean): SkillWithSource =>
    INHERENT_SKILL_NAMES.has(skill.filename)
      ? { ...skill, source: 'builtin' as SkillSource, isGlobal }
      : { ...skill, isGlobal }

  // ============ Workspace Skills (Project-level) ============

  // 1. Load workspace .claude/skills (Cursor/Claude skills)
  if (workspacePath) {
    const claudeDir = `${workspacePath}/.claude/skills`
    const claudeSkills = await loadSkillsFromDir(claudeDir, 'claude')
    for (const s of claudeSkills) pushSkill(labelled(s, false))
  }

  // 2. Load workspace .agents/skills
  if (workspacePath) {
    const sharedDir = `${workspacePath}/.agents/skills`
    const sharedSkills = await loadSkillsFromDir(sharedDir, 'shared')
    for (const s of sharedSkills) pushSkill(labelled(s, false))
  }

  // ============ Global Skills (User-level) ============

  // 3. Load global ~/.claude/skills
  const globalClaudeDir = `${home.replace(/\/$/, '')}/.claude/skills`
  const globalClaudeSkills = await loadSkillsFromDir(globalClaudeDir, 'global-claude')
  for (const s of globalClaudeSkills) pushSkill(labelled(s, true))

  // 4. Load global ~/.agents/skills — where the registry, ClawHub and the
  //    inherent skills all install.
  const globalAgentDir = `${home.replace(/\/$/, '')}/.agents/skills`
  const globalAgentSkills = await loadSkillsFromDir(globalAgentDir, 'global-agent')
  for (const s of globalAgentSkills) pushSkill(labelled(s, true))

  // ============ Dynamic paths from opencode.json ============

  // 5+. Configured skill paths (`opencode.json` → `skills.paths`)
  if (workspacePath) {
    const configPaths = await collectTeamSkillPaths(workspacePath)
    for (const dirPath of configPaths) {
      const skills = await loadSkillsFromDir(dirPath, 'team')
      // Determine if path is global (starts with ~/ or absolute home path)
      const normalizedDirPath = dirPath.replace(/\\/g, '/')
      const normalizedHome = home.replace(/\\/g, '/')
      const isGlobalPath =
        normalizedDirPath.startsWith(normalizedHome) ||
        normalizedDirPath.includes('.claude') ||
        normalizedDirPath.includes('.agents')
      for (const s of skills) pushSkill(labelled(s, isGlobalPath))
    }
  }

  // Deduplicate by filename with priority:
  // claude > global-agent > shared > team > global-claude
  //
  // `global-agent` (~/.agents/skills) is the exception to that ordering: it is
  // where team packs are installed, so it sits ahead of every personal root
  // instead of last among the global ones. A team skill is a team standard, and
  // a member keeping a same-named file of their own must not silently decide
  // what the team's procedure is on their machine — which is also the only
  // reading consistent with auto-follow. Keep this in step with the daemon's
  // `skill_dir_specs` ranks; two loaders disagreeing about which copy is real
  // is the bug this table exists to prevent.
  const priorityOrder: Record<SkillSource, number> = {
    // Role-managed skills, which no root contributes — they are merged in
    // separately and never collide with a scanned slug.
    local: 0,
    claude: 1,
    // Same rank as the root it lives in: `builtin` is a label, and a label must
    // not decide which copy of a duplicated slug wins. The inherent skills only
    // ever exist in `~/.agents/skills`, so the tie is unreachable in practice.
    builtin: 2,
    'global-agent': 2,
    shared: 3,
    team: 4,
    'global-claude': 5,
    personal: 6,
  }
  const seen = new Map<string, SkillWithSource>()

  for (const skill of allSkills) {
    const existing = seen.get(skill.filename)
    if (existing) {
      const existingPriority = priorityOrder[existing.source]
      const newPriority = priorityOrder[skill.source]
      if (newPriority < existingPriority) {
        overrides.push({ name: skill.filename, winner: skill.source, loser: existing.source })
        seen.set(skill.filename, skill)
      } else {
        overrides.push({ name: skill.filename, winner: existing.source, loser: skill.source })
      }
    } else {
      seen.set(skill.filename, skill)
    }
  }

  for (const override of overrides) {
    console.info(
      `[SkillLoader] Skill "${override.name}": ${override.winner} overrides ${override.loser}`
    )
  }

  return {
    skills: Array.from(seen.values()),
    overrides,
  }
}

/**
 * Get the source badge label for display
 */
export function getSourceLabel(source: SkillSource): string {
  switch (source) {
    case 'local':
      return i18n.t('skills.roleManagedLabel')
    case 'claude':
      return 'Claude'
    case 'shared':
      return 'Shared'
    case 'team':
      return 'Team'
    case 'builtin':
      return i18n.t('skills.builtinLabel')
    case 'personal':
      return 'Personal'
    case 'global-claude':
      return 'Global Claude'
    case 'global-agent':
      return 'Global Agent'
  }
}

/**
 * Get the source directory path description for display
 */
export function getSourceDirHint(source: SkillSource): string {
  switch (source) {
    case 'local':
      return 'roles/<role>/skills/'
    case 'claude':
      return '.claude/skills/'
    case 'shared':
      return '.agents/skills/'
    case 'team':
      return 'opencode.json → skills.paths'
    case 'builtin':
      return i18n.t('skills.builtinPath', { app: appDisplayName })
    case 'personal':
      return ''
    case 'global-claude':
      return '~/.claude/skills/'
    case 'global-agent':
      return '~/.agents/skills/'
  }
}

