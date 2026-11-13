// ─── Git Command Result Types ──────────────────────────────────────────────

// ─── Repository Types ──────────────────────────────────────────────────────

// ─── Configuration Types ───────────────────────────────────────────────────

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
  'deploy-app',
  'app-auth',
  'open-computer-use',
])

const RETIRED_DESKTOP_CONTROL_SLUGS = new Set(['macos-control', 'windows-control'])

/** Hide leftover macos-control / windows-control dirs until the daemon deletes them. */
export function shouldIncludeDesktopControlSkill(filename: string): boolean {
  return !RETIRED_DESKTOP_CONTROL_SLUGS.has(filename)
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
