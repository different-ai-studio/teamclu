import { exists, readDir } from '@tauri-apps/plugin-fs'
import { loadAllSkills, getSkillDirectories } from '@/lib/skills/loader'
import type { SkillSource } from '@/lib/skills/types'
import { loadRolesSkillsWorkspaceStateFromFs } from '@/lib/roles/loader'
import {
  encodeWorkspaceId,
  getDaemonRolesSkillsState,
  getDaemonRuntime,
} from '@/lib/daemon-local-client'
import { collectTeamSkillPaths, globalTeamShareDir, TEAM_SHARE_LINK_DIR } from '@/lib/team-skill-paths'
import { TEAMCLU_DIR } from '@/lib/build-config'
import { isTauri } from '@/lib/utils'

export type SkillDiagnosticStatus = 'ok' | 'warn' | 'fail'

export interface SkillDiagnosticCheck {
  id: string
  label: string
  status: SkillDiagnosticStatus
  detail?: string
  hint?: string
}

interface SkillDirectoryScan {
  path: string
  label: string
  exists: boolean
  readable: boolean
  skillCount: number
  brokenDirs: string[]
  error?: string
}

export interface SkillsDiagnosticsReport {
  generatedAt: string
  workspacePath: string
  summary: SkillDiagnosticStatus
  checks: SkillDiagnosticCheck[]
  directories: SkillDirectoryScan[]
  daemonSkillCount: number | null
  fsSkillCount: number
  mergedSkillCount: number
  overrides: Array<{ name: string; winner: SkillSource; loser: SkillSource }>
}

const DIRECTORY_LABELS: Record<string, string> = {
  claude: '.claude/skills',
  agents: '.agents/skills',
  globalClaude: '~/.claude/skills',
  globalAgents: '~/.agents/skills',
}

function worstStatus(current: SkillDiagnosticStatus, next: SkillDiagnosticStatus): SkillDiagnosticStatus {
  if (current === 'fail' || next === 'fail') return 'fail'
  if (current === 'warn' || next === 'warn') return 'warn'
  return 'ok'
}

function summarizeChecks(checks: SkillDiagnosticCheck[]): SkillDiagnosticStatus {
  return checks.reduce<SkillDiagnosticStatus>(
    (acc, check) => worstStatus(acc, check.status),
    'ok',
  )
}

function labelForDirectory(path: string, workspacePath: string): string {
  const normalized = path.replace(/\\/g, '/')
  const workspace = workspacePath.replace(/\\/g, '/')
  if (normalized.includes('/.claude/skills')) {
    return normalized.startsWith(workspace) ? DIRECTORY_LABELS.claude : DIRECTORY_LABELS.globalClaude
  }
  if (normalized.includes('/.agents/skills')) {
    return normalized.startsWith(workspace) ? DIRECTORY_LABELS.agents : DIRECTORY_LABELS.globalAgents
  }
  if (normalized.includes(`/${TEAM_SHARE_LINK_DIR}/skills`)) return `${TEAM_SHARE_LINK_DIR}/skills`
  if (normalized.includes('/roles/skills')) return `${TEAMCLU_DIR}/roles/skills`
  return path
}

async function scanSkillDirectory(path: string, label: string): Promise<SkillDirectoryScan> {
  const scan: SkillDirectoryScan = {
    path,
    label,
    exists: false,
    readable: false,
    skillCount: 0,
    brokenDirs: [],
  }

  try {
    if (!(await exists(path))) {
      return scan
    }
    scan.exists = true

    const entries = await readDir(path)
    scan.readable = true

    for (const entry of entries) {
      if (!entry.isDirectory || !entry.name) continue
      const entryPath = `${path}/${entry.name}`
      const skillMdPath = `${entryPath}/SKILL.md`
      if (await exists(skillMdPath)) {
        scan.skillCount += 1
        continue
      }

      let nestedSkillFound = false
      try {
        const nestedEntries = await readDir(entryPath)
        for (const nested of nestedEntries) {
          if (!nested.isDirectory || !nested.name) continue
          const nestedSkillMd = `${entryPath}/${nested.name}/SKILL.md`
          if (await exists(nestedSkillMd)) {
            scan.skillCount += 1
            nestedSkillFound = true
          }
        }
      } catch {
        // ignore nested read errors
      }

      if (!nestedSkillFound) {
        scan.brokenDirs.push(entry.name)
      }
    }
  } catch (err) {
    scan.error = err instanceof Error ? err.message : String(err)
  }

  return scan
}

export async function runSkillsDiagnostics(workspacePath: string): Promise<SkillsDiagnosticsReport> {
  const checks: SkillDiagnosticCheck[] = []
  const directories: SkillDirectoryScan[] = []

  if (!workspacePath.trim()) {
    return {
      generatedAt: new Date().toISOString(),
      workspacePath,
      summary: 'fail',
      checks: [{
        id: 'workspace',
        label: 'Workspace',
        status: 'fail',
        hint: 'Select a workspace directory before running diagnostics.',
      }],
      directories: [],
      daemonSkillCount: null,
      fsSkillCount: 0,
      mergedSkillCount: 0,
      overrides: [],
    }
  }

  const workspaceExists = await exists(workspacePath)
  checks.push({
    id: 'workspace',
    label: 'Workspace directory',
    status: workspaceExists ? 'ok' : 'fail',
    detail: workspacePath,
    hint: workspaceExists ? undefined : 'The workspace path does not exist on disk.',
  })

  let daemonSkillCount: number | null = null

  if (isTauri()) {
    try {
      const wid = encodeWorkspaceId(workspacePath)
      const [daemonState, runtime] = await Promise.all([
        getDaemonRolesSkillsState(wid),
        getDaemonRuntime(wid),
      ])

      if (daemonState) {
        daemonSkillCount = daemonState.skills.length
        checks.push({
          id: 'daemon',
          label: 'Daemon scan',
          status: 'ok',
          detail: `${daemonSkillCount} skill(s)`,
        })
      } else {
        checks.push({
          id: 'daemon',
          label: 'Daemon scan',
          status: 'warn',
          hint: 'amuxd did not return a skills inventory. The UI falls back to a local filesystem scan.',
        })
      }

      const refresh = runtime?.refresh
      const runtimeRefreshPending = refresh?.status === 'pending' || refresh?.status === 'failed'
      const runtimeSkillsPending = refresh?.change_kinds.includes('skills') ?? false
      const runtimeRefreshError = refresh?.last_error ?? null

      if (refresh?.status === 'failed') {
        checks.push({
          id: 'runtime-refresh',
          label: 'Runtime refresh',
          status: 'fail',
          detail: runtimeRefreshError ?? refresh.status,
          hint: 'Runtime refresh failed. Restart OpenCode from this page or Diagnostics.',
        })
      } else if (runtimeSkillsPending) {
        checks.push({
          id: 'runtime-refresh',
          label: 'Runtime refresh',
          status: 'warn',
          detail: 'Skills changes pending',
          hint: 'Skills changes stay pending until you Apply. New sessions re-discover skills from disk automatically.',
        })
      } else if (runtimeRefreshPending) {
        checks.push({
          id: 'runtime-refresh',
          label: 'Runtime refresh',
          status: 'warn',
          detail: refresh?.change_kinds.join(', ') || 'pending',
          hint: 'Workspace runtime changes are pending reload.',
        })
      } else {
        checks.push({
          id: 'runtime-refresh',
          label: 'Runtime refresh',
          status: 'ok',
          detail: 'Up to date',
        })
      }
    } catch (err) {
      checks.push({
        id: 'daemon',
        label: 'Daemon scan',
        status: 'warn',
        detail: err instanceof Error ? err.message : String(err),
        hint: 'Ensure amuxd is running. Skills may still load from the local filesystem.',
      })
    }
  } else {
    checks.push({
      id: 'daemon',
      label: 'Daemon scan',
      status: 'warn',
      detail: 'Not available in browser mode',
    })
  }

  const teamLinkPath = `${workspacePath}/${TEAM_SHARE_LINK_DIR}`
  const teamLinkExists = await exists(teamLinkPath)
  const globalTeamDir = await globalTeamShareDir()
  checks.push({
    id: 'team-share',
    label: 'Team share directory',
    status: teamLinkExists || !!globalTeamDir ? 'ok' : 'warn',
    detail: teamLinkExists
      ? teamLinkPath
      : globalTeamDir ?? 'Not linked',
    hint: !teamLinkExists && globalTeamDir
      ? `Workspace symlink missing; global team dir is ${globalTeamDir}`
      : !teamLinkExists
        ? 'No team share link found. Team skills from teamclu-team/ will not appear.'
        : undefined,
  })

  const configuredPaths = await collectTeamSkillPaths(workspacePath)
  for (const configPath of configuredPaths) {
    const pathExists = await exists(configPath)
    checks.push({
      id: `config-path:${configPath}`,
      label: 'Configured skill path',
      status: pathExists ? 'ok' : 'fail',
      detail: configPath,
      hint: pathExists ? undefined : 'Path from teamclu.json / opencode.json does not exist or is inaccessible.',
    })
  }

  const skillDirs = await getSkillDirectories(workspacePath)
  for (const dirPath of skillDirs) {
    const label = labelForDirectory(dirPath, workspacePath)
    const scan = await scanSkillDirectory(dirPath, label)
    directories.push(scan)

    if (scan.error) {
      checks.push({
        id: `dir-error:${dirPath}`,
        label: label,
        status: 'fail',
        detail: dirPath,
        hint: scan.error,
      })
    } else if (scan.brokenDirs.length > 0) {
      checks.push({
        id: `dir-broken:${dirPath}`,
        label: label,
        status: 'warn',
        detail: `${scan.brokenDirs.length} folder(s) missing SKILL.md`,
        hint: scan.brokenDirs.slice(0, 5).join(', '),
      })
    } else if (scan.exists && scan.skillCount === 0) {
      checks.push({
        id: `dir-empty:${dirPath}`,
        label: label,
        status: 'ok',
        detail: 'Empty directory',
      })
    } else if (scan.exists) {
      checks.push({
        id: `dir-ok:${dirPath}`,
        label: label,
        status: 'ok',
        detail: `${scan.skillCount} skill(s)`,
      })
    }
  }

  const { skills: fsSkills, overrides } = await loadAllSkills(workspacePath)
  const fsState = await loadRolesSkillsWorkspaceStateFromFs(workspacePath)
  const fsSkillCount = fsSkills.length
  const mergedSkillCount = fsState.skills.length

  checks.push({
    id: 'fs-scan',
    label: 'Filesystem scan',
    status: fsSkillCount > 0 ? 'ok' : 'warn',
    detail: `${fsSkillCount} skill(s)`,
    hint: fsSkillCount === 0 ? 'No skills were found in any configured directory.' : undefined,
  })

  if (daemonSkillCount !== null && daemonSkillCount !== mergedSkillCount) {
    checks.push({
      id: 'count-mismatch',
      label: 'Daemon vs filesystem',
      status: 'warn',
      detail: `daemon ${daemonSkillCount}, filesystem ${mergedSkillCount}`,
      hint: 'Inventory counts differ. Try Refresh, then restart OpenCode if skills still look wrong.',
    })
  }

  if (overrides.length > 0) {
    checks.push({
      id: 'overrides',
      label: 'Name collisions',
      status: 'warn',
      detail: `${overrides.length} duplicate name(s) resolved by priority`,
      hint: overrides.slice(0, 3).map((o) => `${o.name}: ${o.winner} over ${o.loser}`).join('; '),
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    workspacePath,
    summary: summarizeChecks(checks),
    checks,
    directories,
    daemonSkillCount,
    fsSkillCount,
    mergedSkillCount,
    overrides,
  }
}

export function formatSkillsDiagnosticsReport(report: SkillsDiagnosticsReport): string {
  const lines = [
    `Skills diagnostics — ${report.generatedAt}`,
    `Workspace: ${report.workspacePath}`,
    `Summary: ${report.summary}`,
    `Daemon: ${report.daemonSkillCount ?? 'n/a'} | FS: ${report.fsSkillCount} | Merged: ${report.mergedSkillCount}`,
    '',
    'Checks:',
  ]

  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.label}${check.detail ? `: ${check.detail}` : ''}`)
    if (check.hint) lines.push(`  hint: ${check.hint}`)
  }

  if (report.directories.length > 0) {
    lines.push('', 'Directories:')
    for (const dir of report.directories) {
      lines.push(`- ${dir.label} (${dir.path})`)
      lines.push(`  exists=${dir.exists} skills=${dir.skillCount} broken=${dir.brokenDirs.join(', ') || 'none'}`)
      if (dir.error) lines.push(`  error: ${dir.error}`)
    }
  }

  if (report.overrides.length > 0) {
    lines.push('', 'Overrides:')
    for (const override of report.overrides) {
      lines.push(`- ${override.name}: ${override.winner} > ${override.loser}`)
    }
  }

  return lines.join('\n')
}
