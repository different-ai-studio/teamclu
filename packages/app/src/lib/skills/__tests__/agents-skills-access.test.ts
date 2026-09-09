import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

describe('agents-skills-access', () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.resetModules()
  })

  it('returns the IPC payload from checkAgentsSkillsAccess', async () => {
    invoke.mockResolvedValue({
      path: '/Users/me/.agents/skills',
      ok: true,
      kind: 'ok',
      message: 'ok',
      osReadable: true,
      osWritable: true,
      scopeGranted: true,
    })
    const { checkAgentsSkillsAccess } = await import('../agents-skills-access')
    const access = await checkAgentsSkillsAccess()
    expect(invoke).toHaveBeenCalledWith('check_agents_skills_access')
    expect(access.ok).toBe(true)
  })

  it('throws AgentsSkillsAccessError when assert fails', async () => {
    invoke.mockResolvedValue({
      path: '/Users/me/.agents/skills',
      ok: false,
      kind: 'os_permission',
      message: 'Cannot write',
      osReadable: true,
      osWritable: false,
      scopeGranted: true,
    })
    const { assertAgentsSkillsAccess, isAgentsSkillsAccessError } = await import(
      '../agents-skills-access'
    )
    await expect(assertAgentsSkillsAccess()).rejects.toSatisfy((err: unknown) => {
      expect(isAgentsSkillsAccessError(err)).toBe(true)
      if (isAgentsSkillsAccessError(err)) {
        expect(err.access.kind).toBe('os_permission')
      }
      return true
    })
  })
})
