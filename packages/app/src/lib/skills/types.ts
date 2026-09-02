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
  'macos-control',
  'windows-control',
])

const DESKTOP_CONTROL_INHERENT_SLUGS = new Set(['macos-control', 'windows-control'])

/** Host OS–matched built-in desktop automation skill, or null on Linux / unknown. */
function getActiveDesktopControlSkillSlug(): 'macos-control' | 'windows-control' | null {
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
