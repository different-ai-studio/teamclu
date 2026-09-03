import { describe, expect, it, vi, beforeEach } from 'vitest'

const probeDaemonHttp = vi.hoisted(() => vi.fn())
const getKnownLocalDaemonActorId = vi.hoisted(() => vi.fn())

vi.mock('@/lib/daemon/daemon-local-client', () => ({ probeDaemonHttp }))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({ getKnownLocalDaemonActorId }))

import {
  isFullyLocal,
  planAgentTransports,
  resolveAgentTransport,
} from '@/lib/teamclu/agent-transport'

const LOCAL = 'local-daemon-actor'
const REMOTE = 'remote-agent'

describe('resolveAgentTransport', () => {
  beforeEach(() => {
    probeDaemonHttp.mockReset()
    getKnownLocalDaemonActorId.mockReset()
    getKnownLocalDaemonActorId.mockReturnValue(LOCAL)
  })

  it('routes this device’s daemon over loopback when it answers', async () => {
    // The point of the whole module: reaching our own daemon must not depend
    // on reaching a cloud broker.
    probeDaemonHttp.mockResolvedValue({ ok: true })
    expect(await resolveAgentTransport(LOCAL)).toBe('local')
  })

  it('never claims a fast path to another machine', async () => {
    probeDaemonHttp.mockResolvedValue({ ok: true })
    expect(await resolveAgentTransport(REMOTE)).toBe('mqtt')
    // A remote agent must not even cost a loopback probe.
    expect(probeDaemonHttp).not.toHaveBeenCalled()
  })

  it('falls back to the broker when the local daemon is down', async () => {
    // Being the local actor is not enough — there is no fast path to a process
    // that is not running.
    probeDaemonHttp.mockResolvedValue({ ok: false, reason: 'not_running' })
    expect(await resolveAgentTransport(LOCAL)).toBe('mqtt')
  })

  it('falls back to the broker when the probe throws', async () => {
    probeDaemonHttp.mockRejectedValue(new Error('ipc exploded'))
    expect(await resolveAgentTransport(LOCAL)).toBe('mqtt')
  })

  it('is mqtt when this device has no daemon identity at all', async () => {
    getKnownLocalDaemonActorId.mockReturnValue(null)
    expect(await resolveAgentTransport(LOCAL)).toBe('mqtt')
  })
})

describe('planAgentTransports', () => {
  beforeEach(() => {
    probeDaemonHttp.mockReset()
    getKnownLocalDaemonActorId.mockReset()
    getKnownLocalDaemonActorId.mockReturnValue(LOCAL)
  })

  it('splits a mixed batch, so a dead broker strands only the remote agents', async () => {
    probeDaemonHttp.mockResolvedValue({ ok: true })
    const plan = await planAgentTransports([LOCAL, REMOTE])
    expect(plan.local).toEqual([LOCAL])
    expect(plan.mqtt).toEqual([REMOTE])
    expect(isFullyLocal(plan)).toBe(false)
  })

  it('probes once for the whole batch', async () => {
    // There is exactly one local daemon; probing per agent would repeat the
    // same request on every send.
    probeDaemonHttp.mockResolvedValue({ ok: true })
    await planAgentTransports([LOCAL, REMOTE, 'another-remote'])
    expect(probeDaemonHttp).toHaveBeenCalledTimes(1)
  })

  it('skips the probe entirely when no local agent is mentioned', async () => {
    probeDaemonHttp.mockResolvedValue({ ok: true })
    const plan = await planAgentTransports([REMOTE])
    expect(probeDaemonHttp).not.toHaveBeenCalled()
    expect(isFullyLocal(plan)).toBe(false)
  })

  it('reports fully-local for a solo local agent', async () => {
    probeDaemonHttp.mockResolvedValue({ ok: true })
    expect(isFullyLocal(await planAgentTransports([LOCAL]))).toBe(true)
  })

  it('an empty batch is not fully local', async () => {
    // Guards callers that would otherwise read "no agents" as "all fine".
    expect(isFullyLocal(await planAgentTransports([]))).toBe(false)
  })

  it('ignores blank ids', async () => {
    probeDaemonHttp.mockResolvedValue({ ok: true })
    const plan = await planAgentTransports(['  ', LOCAL])
    expect(plan.local).toEqual([LOCAL])
    expect(plan.mqtt).toEqual([])
  })
})
