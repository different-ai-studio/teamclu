import type { RemoteToolExecutor, RemoteToolName } from '@/lib/remote-tools/types'

const executors = new Map<RemoteToolName, RemoteToolExecutor>()

export function registerExecutor(name: RemoteToolName, executor: RemoteToolExecutor): void {
  executors.set(name, executor)
}

export function getExecutor(name: string): RemoteToolExecutor | undefined {
  return executors.get(name as RemoteToolName)
}

export function listLocalCapabilities(): string[] {
  return [...executors.keys()]
}

export function clearExecutorsForTests(): void {
  executors.clear()
}
