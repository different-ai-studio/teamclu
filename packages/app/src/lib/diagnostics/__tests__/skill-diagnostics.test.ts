import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runSkillsDiagnostics, formatSkillsDiagnosticsReport } from '@/lib/diagnostics/skill-diagnostics'

const mockExists = vi.fn(async () => true)
const mockReadDir = vi.fn(async () => [])
const mockLoadAllSkills = vi.fn(async () => ({ skills: [], overrides: [] }))
const mockGetSkillDirectories = vi.fn(async () => ['/workspace/.teamclu/skills'])
const mockLoadRolesSkillsWorkspaceStateFromFs = vi.fn(async () => ({
  roles: [],
  skills: [],
  roleUsageBySkill: {},
  skillNamesByRole: {},
  metrics: {
    rolesCount: 0,
    skillsCount: 0,
    linkedSkillsCount: 0,
    unlinkedSkillsCount: 0,
  },
}))
const mockGetDaemonRolesSkillsState = vi.fn(async () => null)
const mockGetDaemonRuntime = vi.fn(async () => null)
const mockCollectTeamSkillPaths = vi.fn(async () => [])
const mockGlobalTeamShareDir = vi.fn(async () => null)

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => mockExists(...args),
  readDir: (...args: unknown[]) => mockReadDir(...args),
}))

vi.mock('@/lib/skills/loader', () => ({
  loadAllSkills: (...args: unknown[]) => mockLoadAllSkills(...args),
  getSkillDirectories: (...args: unknown[]) => mockGetSkillDirectories(...args),
  getSourceDirHint: (source: string) => source,
}))

vi.mock('@/lib/roles/loader', () => ({
  loadRolesSkillsWorkspaceStateFromFs: (...args: unknown[]) =>
    mockLoadRolesSkillsWorkspaceStateFromFs(...args),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  getDaemonRolesSkillsState: (...args: unknown[]) => mockGetDaemonRolesSkillsState(...args),
  getDaemonRuntime: (...args: unknown[]) => mockGetDaemonRuntime(...args),
}))

vi.mock('@/lib/team/team-skill-paths', () => ({
  collectTeamSkillPaths: (...args: unknown[]) => mockCollectTeamSkillPaths(...args),
  globalTeamShareDir: (...args: unknown[]) => mockGlobalTeamShareDir(...args),
  TEAM_SHARE_LINK_DIR: 'teamclu-team',
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

describe('runSkillsDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockResolvedValue(true)
    mockReadDir.mockResolvedValue([])
    mockLoadAllSkills.mockResolvedValue({ skills: [], overrides: [] })
    mockGetSkillDirectories.mockResolvedValue(['/workspace/.teamclu/skills'])
    mockLoadRolesSkillsWorkspaceStateFromFs.mockResolvedValue({
      roles: [],
      skills: [],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 0,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 0,
      },
    })
    mockGetDaemonRolesSkillsState.mockResolvedValue({
      roles: [],
      skills: [{ filename: 'alpha' }],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 1,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 1,
      },
    })
    mockGetDaemonRuntime.mockResolvedValue({
      workspace_id: 'workspace',
      ready: true,
      backend: 'cloud_api',
      current_model: null,
      refresh: {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'apply_changes',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: null,
        last_error: null,
      },
    })
    mockCollectTeamSkillPaths.mockResolvedValue([])
    mockGlobalTeamShareDir.mockResolvedValue(null)
  })

  it('returns fail when workspace path is empty', async () => {
    const report = await runSkillsDiagnostics('')
    expect(report.summary).toBe('fail')
    expect(report.checks.some((check) => check.id === 'workspace')).toBe(true)
  })

  it('warns when daemon inventory differs from filesystem merge', async () => {
    mockLoadAllSkills.mockResolvedValue({
      skills: [{ filename: 'beta' } as never, { filename: 'gamma' } as never],
      overrides: [],
    })
    mockLoadRolesSkillsWorkspaceStateFromFs.mockResolvedValue({
      roles: [],
      skills: [{ filename: 'beta' } as never, { filename: 'gamma' } as never],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 2,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 2,
      },
    })

    const report = await runSkillsDiagnostics('/workspace')
    expect(report.checks.some((check) => check.id === 'count-mismatch')).toBe(true)
    expect(report.summary).not.toBe('ok')
  })

  it('flags broken skill folders missing SKILL.md', async () => {
    mockReadDir.mockImplementation(async (path: string) => {
      if (path.endsWith('/.teamclu/skills')) {
        return [
          { name: 'broken-skill', isDirectory: true },
          { name: 'good-skill', isDirectory: true },
        ]
      }
      return []
    })
    mockExists.mockImplementation(async (path: string) => {
      if (path.endsWith('/good-skill/SKILL.md')) return true
      if (path.endsWith('/broken-skill/SKILL.md')) return false
      return true
    })

    const report = await runSkillsDiagnostics('/workspace')
    expect(report.directories[0]?.brokenDirs).toContain('broken-skill')
    expect(report.checks.some((check) => check.id.startsWith('dir-broken:'))).toBe(true)
  })
})

describe('formatSkillsDiagnosticsReport', () => {
  it('includes summary and checks in plain text', () => {
    const text = formatSkillsDiagnosticsReport({
      generatedAt: '2026-08-04T08:00:00.000Z',
      workspacePath: '/workspace',
      summary: 'warn',
      checks: [{
        id: 'daemon',
        label: 'Daemon scan',
        status: 'warn',
        hint: 'offline',
      }],
      directories: [],
      daemonSkillCount: null,
      fsSkillCount: 0,
      mergedSkillCount: 0,
      overrides: [],
    })

    expect(text).toContain('Summary: warn')
    expect(text).toContain('[warn] Daemon scan')
    expect(text).toContain('hint: offline')
  })
})
