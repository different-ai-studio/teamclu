import type { SkillSource } from "@/lib/skills/types"

type RoleAttachMode = "copy" | "migrate"

export interface RoleSkillLink {
  name: string
  description: string
}

export interface RoleRecord {
  slug: string
  name: string
  description: string
  body: string
  role: string
  whenToUse: string
  workingStyle: string
  roleSkills: RoleSkillLink[]
  filePath: string
  rawMarkdown: string
}

export interface RoleEditorState {
  slug: string
  name: string
  description: string
  role: string
  whenToUse: string
  workingStyle: string
  roleSkills: RoleSkillLink[]
  rawMarkdown: string
}

export interface AttachableSkill {
  filename: string
  name: string
  description: string
  content: string
  dirPath: string
  source: SkillSource
}

export interface ManagedSkillRecord {
  filename: string
  name: string
  invocationName?: string
  content: string
  description: string
  source?: SkillSource
  dirPath: string
  linkedRoles: string[]
  isRoleSkill: boolean
}

interface RolesSkillsMetrics {
  rolesCount: number
  skillsCount: number
  linkedSkillsCount: number
  unlinkedSkillsCount: number
}

export interface RolesSkillsWorkspaceState {
  roles: RoleRecord[]
  skills: ManagedSkillRecord[]
  roleUsageBySkill: Record<string, string[]>
  skillNamesByRole: Record<string, string[]>
  metrics: RolesSkillsMetrics
}

export interface AttachSkillToRoleInput {
  workspacePath: string
  roleSlug: string
  skillSlug: string
  mode: RoleAttachMode
}
