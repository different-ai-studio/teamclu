import type { SharedModuleLease } from '@/lib/shared-module-lease'

type MqttModuleSetup = {
  name: string
  acquire: () => SharedModuleLease
}

type MqttModuleSetupResult =
  | { name: string; status: 'fulfilled' }
  | { name: string; status: 'rejected'; reason: unknown }

export type MqttModuleLeaseGroup = {
  ready: Promise<MqttModuleSetupResult[]>
  release: () => void
}

/** Acquire all module leases synchronously, then settle them independently. */
export function acquireMqttModuleLeaseGroup(
  setups: readonly MqttModuleSetup[],
): MqttModuleLeaseGroup {
  const leases: SharedModuleLease[] = []
  const pending = setups.map(({ name, acquire }) => {
    try {
      const lease = acquire()
      leases.push(lease)
      return lease.ready.then(
        (): MqttModuleSetupResult => ({ name, status: 'fulfilled' }),
        (reason: unknown): MqttModuleSetupResult => ({ name, status: 'rejected', reason }),
      )
    } catch (reason) {
      return Promise.resolve<MqttModuleSetupResult>({ name, status: 'rejected', reason })
    }
  })

  let released = false
  return {
    ready: Promise.all(pending),
    release: () => {
      if (released) return
      released = true
      for (let index = leases.length - 1; index >= 0; index -= 1) {
        leases[index].release()
      }
    },
  }
}
