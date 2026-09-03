import { describe, expect, it, vi } from 'vitest'
import { acquireMqttModuleLeaseGroup } from '@/lib/mqtt/mqtt-module-wiring'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('mqtt module wiring', () => {
  it('starts all state modules before an unrelated subscription can block wiring', async () => {
    const unrelatedSubscription = new Promise<void>(() => undefined)
    const acquired: string[] = []
    const released: string[] = []
    let group: ReturnType<typeof acquireMqttModuleLeaseGroup> | null = null

    const wire = async () => {
      group = acquireMqttModuleLeaseGroup(
        ['teamclu-rpc', 'remote-tools-rpc', 'runtime-state', 'actor-presence'].map((name) => ({
          name,
          acquire: () => {
            acquired.push(name)
            return {
              ownerId: name,
              ready: Promise.resolve(),
              release: () => released.push(name),
            }
          },
        })),
      )
      await unrelatedSubscription
      await group.ready
    }

    void wire()
    expect(acquired).toEqual([
      'teamclu-rpc',
      'remote-tools-rpc',
      'runtime-state',
      'actor-presence',
    ])
    group!.release()
    expect(released).toEqual([
      'actor-presence',
      'runtime-state',
      'remote-tools-rpc',
      'teamclu-rpc',
    ])
  })

  it('acquires every lease before awaiting and isolates setup failures', async () => {
    const first = deferred()
    const second = deferred()
    const acquired: string[] = []
    const group = acquireMqttModuleLeaseGroup([
      {
        name: 'first',
        acquire: () => {
          acquired.push('first')
          return { ownerId: 'a', ready: first.promise, release: vi.fn() }
        },
      },
      {
        name: 'second',
        acquire: () => {
          acquired.push('second')
          return { ownerId: 'b', ready: second.promise, release: vi.fn() }
        },
      },
    ])

    expect(acquired).toEqual(['first', 'second'])
    first.reject(new Error('transient failure'))
    second.resolve()
    await expect(group.ready).resolves.toEqual([
      { name: 'first', status: 'rejected', reason: expect.any(Error) },
      { name: 'second', status: 'fulfilled' },
    ])
  })

  it('releases pending leases immediately in reverse acquisition order', () => {
    const releaseOrder: string[] = []
    const never = new Promise<void>(() => undefined)
    const group = acquireMqttModuleLeaseGroup([
      {
        name: 'first',
        acquire: () => ({
          ownerId: 'a',
          ready: never,
          release: () => releaseOrder.push('first'),
        }),
      },
      {
        name: 'second',
        acquire: () => ({
          ownerId: 'b',
          ready: never,
          release: () => releaseOrder.push('second'),
        }),
      },
    ])

    group.release()
    group.release()
    expect(releaseOrder).toEqual(['second', 'first'])
  })
})
