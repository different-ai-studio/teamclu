import { homeDir } from "@tauri-apps/api/path"
import { exists, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from "@tauri-apps/plugin-fs"
import type {
  AttachableSkill,
  AttachSkillToRoleInput,
  ManagedSkillRecord,
  RoleEditorState,
  RoleRecord,
  RoleSkillLink,
  RolesSkillsWorkspaceState,
} from "./types"
import { loadAllSkills } from "@/lib/skills/loader"
import type { SkillSource } from "@/lib/skills/types"
import { isTauri } from "@/lib/utils"
import { encodeWorkspaceId, getDaemonRolesSkillsState, putDaemonRole, deleteDaemonRole } from "@/lib/daemon-local-client"

import { TEAMCLU_DIR } from "@/lib/build-config"

const ROLE_ROOT = `${TEAMCLU_DIR}/roles`
const ROLE_SKILL_DIR = `${TEAMCLU_DIR}/roles/skills`
const ROLE_CONFIG_PATH = `${TEAMCLU_DIR}/roles/config.json`
const ROLE_SKILL_DIR_NAME = "skills"

const SECTION_NAMES = {
  role: "Role",
  whenToUse: "When to use",
  roleSkills: "Available role skills",
  workingStyle: "Working style",
} as const

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const normalized = normalizeNewlines(content)
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, body: normalized.trim() }
  }

  const data: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) data[key] = value
  }

  return { data, body: match[2].trim() }
}

function getSection(body: string, heading: string): string {
  const normalized = normalizeNewlines(body)
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im")
  const match = pattern.exec(normalized)
  if (!match) return ""
  const sectionStart = match.index + match[0].length
  const remaining = normalized.slice(sectionStart).replace(/^\n+/, "")
  const nextHeading = remaining.search(/^##\s+/m)
  return (nextHeading === -1 ? remaining : remaining.slice(0, nextHeading)).trim()
}

function parseRoleSkillLinks(sectionContent: string): RoleSkillLink[] {
  if (!sectionContent.trim()) return []
  return sectionContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^-+\s+`([^`]+)`:\s+(.+)$/)
      if (!match) {
        throw new Error(`Invalid role skill entry: ${line}`)
      }
      return {
        name: match[1].trim(),
        description: match[2].trim(),
      }
    })
}

function extractSkillDescription(content: string, fallback: string): string {
  const normalized = normalizeNewlines(content)
  const frontmatterMatch = normalized.match(/^---\n[\s\S]*?\ndescription:\s*(.+?)\n[\s\S]*?---/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()
  const headingMatch = normalized.match(/^#\s+(.+)$/m)
  return headingMatch?.[1]?.trim() ?? fallback
}

type RoleRoot = {
  rootPath: string
  isDefault: boolean
}

export function createEmptyRoleEditorState(): RoleEditorState {
  const empty = {
    slug: "",
    name: "",
    description: "",
    role: "",
    whenToUse: "",
    workingStyle: "",
    roleSkills: [],
  }
  return {
    ...empty,
    rawMarkdown: serializeRoleMarkdown(empty),
  }
}

export function parseRoleMarkdown(content: string, slug: string, filePath = ""): RoleRecord {
  const normalized = normalizeNewlines(content).trim()
  const { data, body } = parseFrontmatter(normalized)
  const name = data.name?.trim() || slug
  const description = data.description?.trim() || ""
  const role = getSection(body, SECTION_NAMES.role)
  const whenToUse = getSection(body, SECTION_NAMES.whenToUse)
  const workingStyle = getSection(body, SECTION_NAMES.workingStyle)
  const roleSkills = parseRoleSkillLinks(getSection(body, SECTION_NAMES.roleSkills))

  return {
    slug,
    name,
    description,
    body,
    role,
    whenToUse,
    workingStyle,
    roleSkills,
    filePath,
    rawMarkdown: normalized,
  }
}

export function serializeRoleMarkdown(input: Pick<RoleEditorState, "slug" | "name" | "description" | "role" | "whenToUse" | "workingStyle" | "roleSkills">): string {
  const parts = [
    "---",
    `name: ${input.slug.trim()}`,
    `description: ${input.description.trim()}`,
    "---",
    "",
    `## ${SECTION_NAMES.role}`,
    input.role.trim(),
    "",
    `## ${SECTION_NAMES.whenToUse}`,
    input.whenToUse.trim(),
    "",
    `## ${SECTION_NAMES.roleSkills}`,
    ...(input.roleSkills.length > 0
      ? input.roleSkills.map((skill) => `- \`${skill.name}\`: ${skill.description}`)
      : [""]),
    "",
    `## ${SECTION_NAMES.workingStyle}`,
    input.workingStyle.trim(),
    "",
  ]

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

async function ensureRolesRoot(workspacePath: string): Promise<void> {
  const rolesRoot = `${workspacePath}/${ROLE_ROOT}`
  if (!(await exists(rolesRoot))) {
    await mkdir(rolesRoot, { recursive: true })
  }
  const fullPath = `${workspacePath}/${ROLE_SKILL_DIR}`
  if (!(await exists(fullPath))) {
    await mkdir(fullPath, { recursive: true })
  }
  const configPath = `${workspacePath}/${ROLE_CONFIG_PATH}`
  if (!(await exists(configPath))) {
    await writeTextFile(configPath, `${JSON.stringify({ paths: [] }, null, 2)}\n`)
  }
}

async function readRoleConfigPaths(workspacePath: string): Promise<string[]> {
  const configPath = `${workspacePath}/${ROLE_CONFIG_PATH}`
  if (!(await exists(configPath))) return []
  try {
    const content = await readTextFile(configPath)
    const parsed = JSON.parse(content)
    const rawPaths: unknown[] = Array.isArray(parsed?.paths) ? parsed.paths : []
    const home = (await homeDir()).replace(/\/$/, "")
    return rawPaths
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => {
        const trimmed = value.trim()
        if (trimmed === "~" || trimmed.startsWith("~/")) {
          return trimmed.replace(/^~/, home)
        }
        if (trimmed.startsWith("/")) return trimmed
        return `${workspacePath}/${trimmed.replace(/^\.\//, "")}`
      })
  } catch {
    return []
  }
}

async function getRoleRoots(workspacePath: string): Promise<RoleRoot[]> {
  await ensureRolesRoot(workspacePath)
  const roots: RoleRoot[] = [{ rootPath: `${workspacePath}/${ROLE_ROOT}`, isDefault: true }]
  const extraPaths = await readRoleConfigPaths(workspacePath)
  for (const path of extraPaths) {
    if (!roots.some((root) => root.rootPath === path)) {
      roots.push({ rootPath: path, isDefault: false })
    }
  }
  return roots
}

async function loadRoleManagedSkills(workspacePath: string): Promise<ManagedSkillRecord[]> {
  const roots = await getRoleRoots(workspacePath)
  const roleSkills: ManagedSkillRecord[] = []
  const seenSkillNames = new Set<string>()

  for (const root of roots) {
    const roleSkillRoot = `${root.rootPath}/${ROLE_SKILL_DIR_NAME}`
    if (!(await exists(roleSkillRoot))) continue
    const entries = await readDir(roleSkillRoot)
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.name || seenSkillNames.has(entry.name)) continue
      const skillPath = `${roleSkillRoot}/${entry.name}/SKILL.md`
      if (!(await exists(skillPath))) continue
      const content = await readTextFile(skillPath)
      seenSkillNames.add(entry.name)
      roleSkills.push({
        filename: entry.name,
        name: entry.name,
        content,
        description: extractSkillDescription(content, entry.name),
        source: "local",
        dirPath: roleSkillRoot,
        linkedRoles: [],
        isRoleSkill: true,
      })
    }
  }

  return roleSkills
}

async function loadAllRolesFromFs(workspacePath: string): Promise<RoleRecord[]> {
  const roles: RoleRecord[] = []
  const seen = new Set<string>()
  const roots = await getRoleRoots(workspacePath)

  for (const root of roots) {
    if (!(await exists(root.rootPath))) continue
    const entries = await readDir(root.rootPath)
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.name || entry.name === ROLE_SKILL_DIR_NAME) continue
      const rolePath = `${root.rootPath}/${entry.name}/ROLE.md`
      if (!(await exists(rolePath))) continue
      if (seen.has(entry.name)) continue
      const content = await readTextFile(rolePath)
      roles.push(parseRoleMarkdown(content, entry.name, rolePath))
      seen.add(entry.name)
    }
  }

  return roles.sort((a, b) => a.slug.localeCompare(b.slug))
}

export async function loadAllRoles(workspacePath: string | null): Promise<RoleRecord[]> {
  const state = await loadRolesSkillsWorkspaceState(workspacePath)
  return state.roles
}

export async function loadRolesSkillsWorkspaceStateFromFs(
  workspacePath: string,
): Promise<RolesSkillsWorkspaceState> {
  const [roles, { skills: normalSkills }, roleManagedSkills] = await Promise.all([
    loadAllRolesFromFs(workspacePath),
    loadAllSkills(workspacePath),
    loadRoleManagedSkills(workspacePath),
  ])

  const roleUsageBySkill: Record<string, string[]> = {}
  const skillNamesByRole: Record<string, string[]> = {}

  for (const role of roles) {
    skillNamesByRole[role.slug] = role.roleSkills.map((skill) => skill.name)
    for (const roleSkill of role.roleSkills) {
      const owners = roleUsageBySkill[roleSkill.name] ?? []
      owners.push(role.slug)
      roleUsageBySkill[roleSkill.name] = owners
    }
  }

  const managedSkillsByKey = new Map<string, ManagedSkillRecord>()

  for (const skill of normalSkills) {
    managedSkillsByKey.set(skill.filename, {
      filename: skill.filename,
      name: skill.name,
      invocationName: skill.invocationName,
      content: skill.content,
      description: extractSkillDescription(skill.content, skill.name),
      source: skill.source,
      dirPath: skill.dirPath,
      linkedRoles: roleUsageBySkill[skill.filename] ?? [],
      isRoleSkill: false,
    })
  }

  for (const skill of roleManagedSkills) {
    const key = `${skill.dirPath}:${skill.filename}`
    managedSkillsByKey.set(key, {
      ...skill,
      linkedRoles: roleUsageBySkill[skill.filename] ?? [],
    })
  }

  const skills = Array.from(managedSkillsByKey.values()).sort((a, b) => {
    if (a.isRoleSkill !== b.isRoleSkill) return a.isRoleSkill ? 1 : -1
    return a.filename.localeCompare(b.filename)
  })

  return buildRolesSkillsWorkspaceState(roles, skills, roleUsageBySkill, skillNamesByRole)
}

function skillRecordKey(skill: Pick<ManagedSkillRecord, "dirPath" | "filename">): string {
  return `${skill.dirPath}:${skill.filename}`
}

const SKILL_SOURCE_PRIORITY: Record<SkillSource, number> = {
  local: 0,
  claude: 1,
  builtin: 2,
  "global-agent": 2,
  shared: 3,
  team: 4,
  "global-claude": 5,
  personal: 10,
}

/** Same filename from team share + `.claude/skills` symlink must collapse to one row. */
function dedupeSkillsByFilename(skills: ManagedSkillRecord[]): ManagedSkillRecord[] {
  const seen = new Map<string, ManagedSkillRecord>()
  for (const skill of skills) {
    const existing = seen.get(skill.filename)
    if (!existing) {
      seen.set(skill.filename, skill)
      continue
    }
    const existingPriority = SKILL_SOURCE_PRIORITY[existing.source ?? "team"] ?? 99
    const nextPriority = SKILL_SOURCE_PRIORITY[skill.source ?? "team"] ?? 99
    if (nextPriority < existingPriority) {
      seen.set(skill.filename, skill)
    }
  }
  return Array.from(seen.values())
}

function buildRolesSkillsWorkspaceState(
  roles: RoleRecord[],
  skills: ManagedSkillRecord[],
  roleUsageBySkill: Record<string, string[]>,
  skillNamesByRole: Record<string, string[]>,
): RolesSkillsWorkspaceState {
  const linkedSkillsCount = Object.entries(roleUsageBySkill).filter(([filename, owners]) =>
    owners.length > 0 && skills.some((skill) => skill.filename === filename),
  ).length

  return {
    roles,
    skills,
    roleUsageBySkill,
    skillNamesByRole,
    metrics: {
      rolesCount: roles.length,
      skillsCount: skills.length,
      linkedSkillsCount,
      unlinkedSkillsCount: Math.max(skills.length - linkedSkillsCount, 0),
    },
  }
}

function normalizeDaemonRolesSkillsState(
  daemonState: NonNullable<Awaited<ReturnType<typeof getDaemonRolesSkillsState>>>,
): RolesSkillsWorkspaceState {
  const skills = daemonState.skills.map((skill) => ({
    ...skill,
    source: skill.source as SkillSource | undefined,
  }))
  return buildRolesSkillsWorkspaceState(
    daemonState.roles as RoleRecord[],
    skills,
    daemonState.roleUsageBySkill,
    daemonState.skillNamesByRole,
  )
}

/**
 * Merge daemon scan with a local FS scan. Daemon rows win on key collision so
 * live inventory stays canonical; FS-only rows (e.g. teamclu-team via Tauri FS
 * when daemon missed a symlinked tree) are retained.
 */
function mergeRolesSkillsStates(
  primary: RolesSkillsWorkspaceState,
  supplement: RolesSkillsWorkspaceState,
): RolesSkillsWorkspaceState {
  const skillsByKey = new Map<string, ManagedSkillRecord>()
  for (const skill of primary.skills) {
    skillsByKey.set(skillRecordKey(skill), skill)
  }
  for (const skill of supplement.skills) {
    const key = skillRecordKey(skill)
    if (!skillsByKey.has(key)) {
      skillsByKey.set(key, skill)
    }
  }

  const skills = dedupeSkillsByFilename(Array.from(skillsByKey.values())).sort((a, b) => {
    if (a.isRoleSkill !== b.isRoleSkill) return a.isRoleSkill ? 1 : -1
    return a.filename.localeCompare(b.filename)
  })

  const roleUsageBySkill = { ...supplement.roleUsageBySkill, ...primary.roleUsageBySkill }
  const skillNamesByRole =
    Object.keys(primary.skillNamesByRole).length > 0
      ? primary.skillNamesByRole
      : supplement.skillNamesByRole
  const roles = primary.roles.length > 0 ? primary.roles : supplement.roles

  return buildRolesSkillsWorkspaceState(roles, skills, roleUsageBySkill, skillNamesByRole)
}

export async function loadRolesSkillsWorkspaceState(workspacePath: string | null): Promise<RolesSkillsWorkspaceState> {
  if (!workspacePath) {
    return buildRolesSkillsWorkspaceState([], [], {}, {})
  }

  if (isTauri()) {
    try {
      const daemonState = await getDaemonRolesSkillsState(encodeWorkspaceId(workspacePath))
      if (daemonState) {
        const daemonNormalized = normalizeDaemonRolesSkillsState(daemonState)
        try {
          const fsState = await loadRolesSkillsWorkspaceStateFromFs(workspacePath)
          return mergeRolesSkillsStates(daemonNormalized, fsState)
        } catch (fsErr) {
          console.warn("[roles/loader] FS supplement after daemon scan failed:", fsErr)
          return daemonNormalized
        }
      }
    } catch (err) {
      console.warn("[roles/loader] daemon roles-skills fetch failed, falling back to FS:", err)
    }
  }

  return loadRolesSkillsWorkspaceStateFromFs(workspacePath)
}

export async function saveRole(workspacePath: string, editor: RoleEditorState, targetFilePath?: string): Promise<RoleRecord> {
  const slug = editor.slug.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  if (!slug) {
    throw new Error("Role name is required")
  }

  const markdown = serializeRoleMarkdown({ ...editor, slug })

  if (isTauri()) {
    try {
      const saved = await putDaemonRole(encodeWorkspaceId(workspacePath), slug, {
        rawMarkdown: markdown,
        targetFilePath,
      })
      if (saved) {
        return saved as RoleRecord
      }
    } catch (err) {
      console.warn("[roles/loader] daemon role save failed, falling back to FS:", err)
    }
  }

  await ensureRolesRoot(workspacePath)
  const rolePath = targetFilePath ?? `${workspacePath}/${ROLE_ROOT}/${slug}/ROLE.md`
  const roleDir = rolePath.slice(0, rolePath.lastIndexOf("/"))
  if (!(await exists(roleDir))) {
    await mkdir(roleDir, { recursive: true })
  }

  await writeTextFile(rolePath, markdown)
  return parseRoleMarkdown(markdown, slug, rolePath)
}

export async function deleteRole(workspacePath: string, roleSlug: string, roleFilePath?: string): Promise<void> {
  if (isTauri()) {
    try {
      const deleted = await deleteDaemonRole(
        encodeWorkspaceId(workspacePath),
        roleSlug,
        roleFilePath,
      )
      if (deleted) return
    } catch (err) {
      console.warn("[roles/loader] daemon role delete failed, falling back to FS:", err)
    }
  }

  if (roleFilePath) {
    const roleDirFromPath = roleFilePath.slice(0, roleFilePath.lastIndexOf("/"))
    if (await exists(roleDirFromPath)) {
      await remove(roleDirFromPath, { recursive: true })
      return
    }
  }

  const roots = await getRoleRoots(workspacePath)
  let roleDir = `${workspacePath}/${ROLE_ROOT}/${roleSlug}`
  for (const root of roots) {
    const candidate = `${root.rootPath}/${roleSlug}`
    if (await exists(candidate)) {
      roleDir = candidate
      break
    }
  }
  if (await exists(roleDir)) {
    await remove(roleDir, { recursive: true })
  }
}

/**
 * Skills a role can be given a copy of.
 *
 * Scoped to the TeamClu-managed roots — `~/.agents/skills` (where the desktop
 * writes new skills, and where the registry and ClawHub install) and the
 * workspace's `.agents/skills`. This used to be the brand meta skills dir,
 * which nothing writes and nothing scans any more; `.claude/skills` is
 * deliberately left out, because those belong to Claude Code rather than to
 * this app.
 */
export async function loadAttachableSkills(workspacePath: string): Promise<AttachableSkill[]> {
  const { skills } = await loadAllSkills(workspacePath)
  return skills
    .filter((skill) => skill.source === "global-agent" || skill.source === "shared")
    .map((skill) => ({
      filename: skill.filename,
      name: skill.name,
      description: extractSkillDescription(skill.content, skill.name),
      content: skill.content,
      dirPath: skill.dirPath,
      source: skill.source,
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename))
}

async function copyItem(sourcePath: string, targetDir: string): Promise<void> {
  const name = sourcePath.split("/").pop()
  if (!name) throw new Error(`Invalid source path: ${sourcePath}`)
  const destinationPath = `${targetDir}/${name}`

  try {
    const entries = await readDir(sourcePath)
    if (!(await exists(destinationPath))) {
      await mkdir(destinationPath, { recursive: true })
    }
    for (const entry of entries) {
      if (!entry.name) continue
      await copyItem(`${sourcePath}/${entry.name}`, destinationPath)
    }
    return
  } catch {
    const bytes = await readFile(sourcePath)
    await writeFile(destinationPath, bytes)
  }
}

async function findExistingRoleSkill(workspacePath: string, skillSlug: string): Promise<{ roleSkillPath: string; roleSkillRoot: string } | null> {
  const roots = await getRoleRoots(workspacePath)
  for (const root of roots) {
    const roleSkillRoot = `${root.rootPath}/${ROLE_SKILL_DIR_NAME}`
    const roleSkillPath = `${roleSkillRoot}/${skillSlug}/SKILL.md`
    if (await exists(roleSkillPath)) {
      return { roleSkillPath, roleSkillRoot }
    }
  }
  return null
}

function upsertRoleSkillLink(links: RoleSkillLink[], next: RoleSkillLink): RoleSkillLink[] {
  const existing = links.find((link) => link.name === next.name)
  if (!existing) return [...links, next]
  return links.map((link) => (link.name === next.name ? next : link))
}

export async function attachSkillToRole(input: AttachSkillToRoleInput): Promise<RoleRecord> {
  const { workspacePath, roleSlug, skillSlug, mode } = input
  await ensureRolesRoot(workspacePath)

  const rolePath = `${workspacePath}/${ROLE_ROOT}/${roleSlug}/ROLE.md`
  if (!(await exists(rolePath))) {
    throw new Error(`Role "${roleSlug}" does not exist`)
  }

  // Resolve the source through the attachable list rather than assuming a
  // root: the skill can be in `~/.agents/skills` or the workspace's
  // `.agents/skills`, and the single dir this used to hard-code (the brand meta
  // skills dir) is not written or scanned any more, so attaching always failed
  // with "not available".
  const attachable = await loadAttachableSkills(workspacePath)
  const source = attachable.find((skill) => skill.filename === skillSlug)
  if (!source) {
    throw new Error(`Skill "${skillSlug}" is not available for role attachment`)
  }
  const sourceDir = `${source.dirPath}/${skillSlug}`
  const sourceSkillPath = `${sourceDir}/SKILL.md`
  if (!(await exists(sourceSkillPath))) {
    throw new Error(`Skill "${skillSlug}" is not available for role attachment`)
  }

  const roleSkillDir = `${workspacePath}/${ROLE_SKILL_DIR}/${skillSlug}`
  const roleSkillPath = `${roleSkillDir}/SKILL.md`
  const existingRoleSkill = await findExistingRoleSkill(workspacePath, skillSlug)
  if (existingRoleSkill) {
    const existingRole = parseRoleMarkdown(await readTextFile(rolePath), roleSlug, rolePath)
    if (existingRole.roleSkills.some((skill) => skill.name === skillSlug)) {
      return existingRole
    }
    throw new Error(`Role skill "${skillSlug}" already exists`)
  }

  const roleSkillRoot = `${workspacePath}/${ROLE_SKILL_DIR}`
  if (!(await exists(roleSkillRoot))) {
    await mkdir(roleSkillRoot, { recursive: true })
  }

  if (mode === "copy") {
    await mkdir(roleSkillDir, { recursive: true })
    await copyItem(sourceDir, roleSkillRoot)
  } else {
    await rename(sourceDir, roleSkillDir)
  }

  const role = parseRoleMarkdown(await readTextFile(rolePath), roleSlug, rolePath)
  const skillContent = await readTextFile(roleSkillPath)
  const nextRole = {
    ...role,
    roleSkills: upsertRoleSkillLink(role.roleSkills, {
      name: skillSlug,
      description: extractSkillDescription(skillContent, skillSlug),
    }),
  }

  await writeTextFile(rolePath, serializeRoleMarkdown(nextRole))
  return parseRoleMarkdown(await readTextFile(rolePath), roleSlug, rolePath)
}

export { extractSkillDescription }
