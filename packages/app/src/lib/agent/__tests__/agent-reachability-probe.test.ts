import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockProbeDaemonHttp = vi.fn()
const mockProbeAgentRpcReachability = vi.fn()

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  probeDaemonHttp: (...args: unknown[]) => mockProbeDaemonHttp(...args),
}))

vi.mock('@/lib/daemon/teamclu-rpc', () => ({
  probeAgentRpcReachability: (...args: unknown[]) => mockProbeAgentRpcReachability(...args),
}))

describe('probeAgentReachability', () => {
  beforeEach(() => {
    mockProbeDaemonHttp.mockReset()
    mockProbeAgentRpcReachability.mockReset()
  })

  it('uses HTTP health for the local daemon actor', async () => {
    mockProbeDaemonHttp.mockResolvedValue({ ok: true, baseUrl: 'http://127.0.0.1:1' })
    const { probeAgentReachability } = await import('@/lib/agent/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'local-agent',
        localDaemonActorId: 'local-agent',
      }),
    ).resolves.toBe('reachable')
    expect(mockProbeAgentRpcReachability).not.toHaveBeenCalled()
  })

  it('marks local daemon unreachable when HTTP probe fails', async () => {
    mockProbeDaemonHttp.mockResolvedValue({ ok: false, reason: 'not_running' })
    const { probeAgentReachability } = await import('@/lib/agent/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'local-agent',
        localDaemonActorId: 'local-agent',
      }),
    ).resolves.toBe('unreachable')
  })

  it('uses short RPC for remote agent actors', async () => {
    mockProbeAgentRpcReachability.mockResolvedValue('reachable')
    const { probeAgentReachability } = await import('@/lib/agent/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'remote-agent',
        localDaemonActorId: 'local-agent',
      }),
    ).resolves.toBe('reachable')
    expect(mockProbeAgentRpcReachability).toHaveBeenCalledWith({
      targetActorId: 'remote-agent',
      timeoutMs: 3_000,
    })
  })

  it('marks remote agent unreachable when RPC fails', async () => {
    mockProbeAgentRpcReachability.mockResolvedValue('unreachable')
    const { probeAgentReachability } = await import('@/lib/agent/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'old-macpro',
        localDaemonActorId: 'new-local',
      }),
    ).resolves.toBe('unreachable')
  })

  it('keeps local transport setup failures indeterminate', async () => {
    mockProbeAgentRpcReachability.mockResolvedValue('indeterminate')
    const { probeAgentReachability } = await import('@/lib/agent/agent-reachability-probe')
    await expect(
      probeAgentReachability({
        agentActorId: 'old-macpro',
        localDaemonActorId: 'new-local',
      }),
    ).resolves.toBe('indeterminate')
  })
})
