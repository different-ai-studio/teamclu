// ─── Git Command Result Types ──────────────────────────────────────────────

/** Raw result from a git command execution via Tauri */
export interface GitCommandResult {
  success: boolean
  stdout: string
  stderr: string
}

/** Structured file status entry from git status */
export interface GitFileStatusEntry {
  path: string
  status: string
  staged: boolean
}

/** Structured git status response */
export interface GitStatusResult {
  branch: string | null
  files: GitFileStatusEntry[]
  clean: boolean
}

/** A single commit entry from `git log --follow` for a file */
export interface GitLogEntry {
  sha: string
  /** First-parent SHA. Empty string for the initial commit. */
  parentSha: string
  author: string
  /** Strict ISO 8601 (e.g. "2026-04-27T10:00:00+00:00"). */
  isoTime: string
  subject: string
}

// ─── Repository Types ──────────────────────────────────────────────────────

/** Source type of a git-managed repository */
export type RepoSource = 'team' | 'personal'

/** Resource type managed by the repository */
export type RepoResourceType = 'skills' | 'documents'

/** Sync status of a repository */
export type RepoSyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

/** Represents a managed git repository */
export interface GitRepo {
  /** Unique identifier: `${source}/${resourceType}` */
  id: string
  /** Remote URL (HTTPS or SSH) */
  url: string
  /** Local path where the repo is cloned */
  localPath: string
  /** Source: team or personal */
  source: RepoSource
  /** Resource type: skills or documents */
  resourceType: RepoResourceType
  /** Current sync status */
  syncStatus: RepoSyncStatus
  /** Last sync timestamp (ISO string) */
  lastSyncAt?: string
  /** Last error message if syncStatus is 'error' */
  lastError?: string
  /** Whether the repo has been cloned locally */
  isCloned: boolean
}

// ─── Configuration Types ───────────────────────────────────────────────────

/** Git repository configuration stored in user config */
export interface GitRepoConfig {
  /** Personal skills repo URL */
  personalSkillsUrl?: string
  /** Personal documents repo URL */
  personalDocumentsUrl?: string
  /** Team repo configuration (one team per workspace) */
  team?: TeamGitConfig
}

/** Git config for team repos */
export interface TeamGitConfig {
  /** Team skills repo URL */
  skillsUrl?: string
  /** Team documents repo URL */
  documentsUrl?: string
}

/** A team member in the allowlist */
export interface TeamMember {
  /** Iroh NodeId (Ed25519 public key) */
  nodeId: string
  /** Human-readable display name (e.g. "Alice", "Bob") */
  name: string
  /** Member role: owner, manager, editor, or viewer */
  role?: 'owner' | 'manager' | 'editor' | 'viewer'
  /** Shortcut visibility roles used to filter team shortcuts */
  shortcutsRole?: string[]
  /** Human-readable label */
  label: string
  /** OS name */
  platform: string
  /** CPU architecture */
  arch: string
  /** Device hostname */
  hostname: string
  /** ISO timestamp when added */
  addedAt: string
}

/** Type guard for TeamMember */
export function isTeamMember(obj: unknown): obj is TeamMember {
  if (obj == null || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    typeof o.nodeId === 'string' &&
    typeof o.label === 'string' &&
    typeof o.platform === 'string' &&
    typeof o.arch === 'string' &&
    typeof o.hostname === 'string' &&
    typeof o.addedAt === 'string'
  )
}

// ─── Skill Source Types ────────────────────────────────────────────────────

/** Source badge for a loaded skill */
/**
 * Where a skill was loaded from. One entry per root in the daemon's
 * `skill_dir_specs`, plus three labels that are not roots:
 *
 * - `builtin` — an inherent skill, decided by name wherever it sits.
 * - `local` — role-managed, from `{meta}/roles/<role>/skills`. The only
 *   remaining meaning of this value: it used to be the brand meta skills dir,
 *   which is not scanned any more.
 * - `personal` — an Agent inventory row, which carries no path at all.
 */
export type SkillSource =
  | 'claude'
  | 'shared'
  | 'personal'
  | 'team'
  | 'builtin'
  | 'local'
  | 'global-claude'
  | 'global-agent'

/** Skill directory names that TeamClu auto-provisions as inherent (cannot be deleted) */
export const INHERENT_SKILL_NAMES = new Set([
  'create-role',
  'macos-control',
  'windows-control',
])

const DESKTOP_CONTROL_INHERENT_SLUGS = new Set(['macos-control', 'windows-control'])

/** Host OS–matched built-in desktop automation skill, or null on Linux / unknown. */
export function getActiveDesktopControlSkillSlug(): 'macos-control' | 'windows-control' | null {
  if (typeof navigator === 'undefined') return null
  const platform = (navigator.platform ?? '').toLowerCase()
  const ua = (navigator.userAgent ?? '').toLowerCase()
  if (platform.includes('mac') || platform.includes('darwin') || ua.includes('mac os')) {
    return 'macos-control'
  }
  if (platform.includes('win') || ua.includes('windows')) {
    return 'windows-control'
  }
  return null
}

/** Hide the non-native desktop control inherent skill in UI / merged lists (legacy skill dir is cleaned in Rust). */
export function shouldIncludeDesktopControlSkill(filename: string): boolean {
  if (!DESKTOP_CONTROL_INHERENT_SLUGS.has(filename)) return true
  const active = getActiveDesktopControlSkillSlug()
  return active !== null && filename === active
}

/** Extended skill info with source tracking */
export interface SkillWithSource {
  filename: string
  name: string
  invocationName: string
  content: string
  source: SkillSource
  /** Absolute path to the directory containing this skill's folder */
  dirPath: string
  /** Whether this is a global skill (from user home directory) */
  isGlobal?: boolean
}
