import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'
import { appShortName, resolveAmuxdDirName } from '@/lib/build-config'

/**
 * Workspace symlink/dir name for team-shared content.
 * Must match `TEAM_LINK_NAME` in `apps/daemon/src/config/global_team_store.rs`.
 */
export const TEAM_SHARE_LINK_DIR = 'teamclu-team'

/**
 * Slug the daemon uses for a team directory it has not been claimed by yet
 * (`layout::UNCLAIMED_TEAM`). It is a placeholder, not an onboarded team.
 */
const UNCLAIMED_TEAM = '_unclaimed'

/**
 * This build's amuxd home: `~/.amuxd` (official) or `~/.amuxd-<brand>`
 * (white-label). Must match `teamclu_runtime_env::amuxd_home_for_brand`.
 */
export function amuxdHomePath(userHome: string, shortName: string = appShortName): string {
  return `${trimTrailingPathSeparators(userHome)}/.${resolveAmuxdDirName(shortName)}`
}

async function amuxdRoot(): Promise<string> {
  return amuxdHomePath(await homeDir())
}

async function readOnboardedTeamId(): Promise<string | null> {
  try {
    const configPath = `${await amuxdRoot()}/daemon.toml`
    if (!(await exists(configPath))) return null
    const content = await readTextFile(configPath)
    // `active_team` is the v2 name; `team_id` is the v1 one the daemon still
    // accepts (`DaemonConfig::team_id`'s serde alias), so a daemon older than
    // the app is read rather than reported as un-onboarded.
    const match =
      content.match(/^\s*active_team\s*=\s*"([^"]+)"/m) ??
      content.match(/^\s*team_id\s*=\s*"([^"]+)"/m)
    const teamId = match?.[1]?.trim()
    if (!teamId || teamId === UNCLAIMED_TEAM) return null
    return teamId
  } catch {
    return null
  }
}

/**
 * Global team share dir for this build:
 * `~/.amuxd[-<brand>]/teams/<team_id>/shared/teamclu-team`.
 *
 * The `shared/` level is layout v2 (`layout::team_shared_dir`). v1 kept the
 * link dir directly under `teams/<id>/`, and needs no fallback here: the v2
 * daemon deletes the v1 directory on its first boot rather than moving it
 * (`purge_v1_layout`), so it is gone before this ever runs.
 */
async function globalTeamDir(teamId: string): Promise<string> {
  return `${await amuxdRoot()}/teams/${teamId}/shared/${TEAM_SHARE_LINK_DIR}`
}

/**
 * The single global team share dir for this build's amuxd home, regardless of
 * whether it exists on disk. Returns `null` only when no team is onboarded (no
 * `active_team` in `<amuxd home>/daemon.toml`).
 *
 * This is the daemon-owned canonical copy. We intentionally do NOT consider the
 * per-workspace `teamclu-team` symlink here — reading the global dir directly
 * is robust against a missing or dangling workspace link.
 */
export async function globalTeamShareDir(): Promise<string | null> {
  const teamId = await readOnboardedTeamId()
  if (!teamId) return null
  return globalTeamDir(teamId)
}

/**
 * Resolve the global team share dir, but only when it actually exists on disk.
 * Used by callers that want to enumerate real content (skills, knowledge); they
 * treat `null` as "nothing to contribute".
 */
export async function resolveTeamDir(_workspacePath: string): Promise<string | null> {
  const globalDir = await globalTeamShareDir()
  if (!globalDir) return null
  return (await exists(globalDir)) ? globalDir : null
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[/\\]+$/, '')
}

function trimLeadingPathSeparators(path: string): string {
  return path.replace(/^[/\\]+/, '')
}

function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path)
}

function joinPath(parent: string, child: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${trimTrailingPathSeparators(parent)}${separator}${trimLeadingPathSeparators(child)}`
}

async function readSkillPathsFromConfig(
  workspacePath: string,
  configFileName: string,
): Promise<string[]> {
  try {
    const configPath = `${workspacePath}/${configFileName}`
    if (!(await exists(configPath))) return []
    const content = await readTextFile(configPath)
    const config = JSON.parse(content) as { skills?: { paths?: unknown } }
    const rawPaths = Array.isArray(config?.skills?.paths) ? config.skills.paths : []
    const home = trimTrailingPathSeparators(await homeDir())
    return rawPaths
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => {
        const trimmed = p.trim()
        if (trimmed === '~') return home
        if (/^~[\\/]/.test(trimmed)) {
          return joinPath(home, trimmed.slice(2))
        }
        return isAbsolutePath(trimmed) ? trimmed : joinPath(workspacePath, trimmed)
      })
  } catch {
    return []
  }
}

async function remapTeamSkillPath(
  workspacePath: string,
  path: string,
  teamId: string | null,
): Promise<string | null> {
  if (await exists(path)) return path
  if (!teamId) return null

  const linkRoot = `${workspacePath}/${TEAM_SHARE_LINK_DIR}`
  if (!path.startsWith(linkRoot)) return null

  const rel = path.slice(linkRoot.length).replace(/^[/\\]+/, '')
  const globalDir = await globalTeamDir(teamId)
  const remapped = rel ? joinPath(globalDir, rel) : globalDir
  return (await exists(remapped)) ? remapped : null
}

/**
 * All directories that should contribute `source: 'team'` skills for a workspace.
 *
 * One source: `opencode.json` → `skills.paths`. It is the only config anything
 * writes — the desktop's `ensure_agents_skills_paths` registers
 * `~/.agents/skills` there — and the daemon reads exactly the same file
 * (`config::roles_skills::collect_team_skill_paths`).
 *
 * Two former sources are gone. `teamclu.json` never had a writer for
 * `skills.paths`. `<workspace>/teamclu-team/skills` lost its writer when
 * `skills/` moved to the registry and joined the OSS sync's RETIRED_PREFIXES;
 * the leftovers on disk kept reaching agents, which is exactly the "quietly
 * running a version the team retired" case the registry exists to end.
 */
export async function collectTeamSkillPaths(workspacePath: string): Promise<string[]> {
  const dirs = new Set<string>()
  const teamId = await readOnboardedTeamId()

  for (const path of await readSkillPathsFromConfig(workspacePath, 'opencode.json')) {
    const resolved = await remapTeamSkillPath(workspacePath, path, teamId)
    if (resolved) dirs.add(resolved)
  }

  return Array.from(dirs)
}

/** Raw `skills.paths` entries, unresolved — used by tests that assert parsing. */
export async function readConfigSkillPaths(workspacePath: string): Promise<string[]> {
  return readSkillPathsFromConfig(workspacePath, 'opencode.json')
}
