/**
 * Reader/writer for teamclu.json — workspace-level config (skill permissions, etc.).
 *
 * LLM providers are managed via the daemon workspace-control API (`opencode.json`);
 * do not read or write `provider` in teamclu.json for model selection.
 */

export type SkillPermission = 'allow' | 'deny' | 'ask'

export type SkillPermissionMap = Record<string, SkillPermission>

export interface ResolvedPermission {
  permission: SkillPermission
  matchedPattern: string
  isExact: boolean
}

interface TeamcluConfig {
  [key: string]: unknown
  permission?: {
    skill?: SkillPermissionMap
    [key: string]: unknown
  }
}

async function readTeamcluConfig(workspacePath: string): Promise<TeamcluConfig> {
  const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
  const configPath = `${workspacePath}/teamclu.json`

  if (!(await exists(configPath))) {
    return {}
  }

  const content = await readTextFile(configPath)
  return JSON.parse(content) as TeamcluConfig
}

async function writeTeamcluConfig(workspacePath: string, config: TeamcluConfig): Promise<void> {
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  const configPath = `${workspacePath}/teamclu.json`
  await writeTextFile(configPath, JSON.stringify(config, null, 2))
}

// ─── Skill Permission Helpers ───────────────────────────────────────────────

function matchesPattern(skillName: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === skillName
  const prefix = pattern.slice(0, -1)
  return skillName.startsWith(prefix)
}

/**
 * Resolve the effective permission for a skill name against a permission map.
 * Priority: exact match > prefix wildcard (longer prefix wins) > global "*"
 */
export function resolveSkillPermission(
  skillName: string,
  permissions: SkillPermissionMap
): ResolvedPermission {
  if (permissions[skillName]) {
    return { permission: permissions[skillName], matchedPattern: skillName, isExact: true }
  }

  let bestMatch: { pattern: string; prefixLen: number } | null = null
  for (const pattern of Object.keys(permissions)) {
    if (pattern === '*' || pattern === skillName) continue
    if (matchesPattern(skillName, pattern)) {
      const prefixLen = pattern.length
      if (!bestMatch || prefixLen > bestMatch.prefixLen) {
        bestMatch = { pattern, prefixLen }
      }
    }
  }

  if (bestMatch) {
    return { permission: permissions[bestMatch.pattern], matchedPattern: bestMatch.pattern, isExact: false }
  }

  if (permissions['*']) {
    return { permission: permissions['*'], matchedPattern: '*', isExact: false }
  }

  return { permission: 'allow', matchedPattern: '*', isExact: false }
}

export async function readSkillPermissions(workspacePath: string): Promise<SkillPermissionMap> {
  try {
    const config = await readTeamcluConfig(workspacePath)
    return config.permission?.skill ?? {}
  } catch {
    return {}
  }
}

export async function writeSkillPermission(
  workspacePath: string,
  pattern: string,
  permission: SkillPermission
): Promise<void> {
  const config = await readTeamcluConfig(workspacePath)
  if (!config.permission) config.permission = {}
  if (!config.permission.skill) config.permission.skill = {}
  config.permission.skill[pattern] = permission
  await writeTeamcluConfig(workspacePath, config)
}

export async function removeSkillPermission(
  workspacePath: string,
  pattern: string
): Promise<void> {
  const config = await readTeamcluConfig(workspacePath)
  if (!config.permission?.skill) return
  delete config.permission.skill[pattern]
  if (Object.keys(config.permission.skill).length === 0) {
    delete config.permission.skill
  }
  if (Object.keys(config.permission).length === 0) {
    delete config.permission
  }
  await writeTeamcluConfig(workspacePath, config)
}
