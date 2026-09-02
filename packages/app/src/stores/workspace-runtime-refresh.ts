import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import {
  encodeWorkspaceId,
  getDaemonRuntime,
  type DaemonRuntimeRefresh,
  type DaemonRuntimeRefreshStatus,
} from '@/lib/daemon-local-client'

const POLL_CLEAN_MS = 12_000
const POLL_ACTIVE_MS = 4_000

interface WorkspaceRuntimeRefreshState {
  workspacePath: string | null
  refresh: DaemonRuntimeRefresh | null
  dismissedAt: string | null
  startPolling: (workspacePath: string) => void
  stopPolling: () => void
  refreshNow: (workspacePath?: string) => Promise<void>
  /** Optimistic pending state when local skill files change before daemon poll catches up. */
  noteLocalRefresh: (changeKinds?: string[]) => void
  dismissBanner: () => void
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollWorkspacePath: string | null = null

function pollIntervalFor(status: DaemonRuntimeRefreshStatus | null | undefined): number {
  if (status === 'pending' || status === 'failed') {
    return POLL_ACTIVE_MS
  }
  return POLL_CLEAN_MS
}

function schedulePoll(intervalMs: number) {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    const path = pollWorkspacePath
    if (path) void useWorkspaceRuntimeRefreshStore.getState().refreshNow(path)
  }, intervalMs)
}

export const useWorkspaceRuntimeRefreshStore = create<WorkspaceRuntimeRefreshState>((set, get) => ({
  workspacePath: null,
  refresh: null,
  dismissedAt: null,

  startPolling(workspacePath: string) {
    pollWorkspacePath = workspacePath
    set({ workspacePath, dismissedAt: null })
    void get().refreshNow(workspacePath)
  },

  stopPolling() {
    pollWorkspacePath = null
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    set({
      workspacePath: null,
      refresh: null,
      dismissedAt: null,
    })
  },

  noteLocalRefresh(changeKinds: string[] = ['skills']) {
    const workspacePath = get().workspacePath ?? pollWorkspacePath
    const lastDetectedAt = new Date().toISOString()
    set({
      workspacePath: workspacePath ?? null,
      dismissedAt: null,
      refresh: {
        status: 'pending',
        change_kinds: changeKinds,
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: lastDetectedAt,
        last_error: null,
      },
    })
    if (workspacePath) {
      schedulePoll(POLL_ACTIVE_MS)
    }
  },

  dismissBanner() {
    const lastDetectedAt = get().refresh?.last_detected_at ?? new Date().toISOString()
    set({ dismissedAt: lastDetectedAt })
  },

  async refreshNow(workspacePathArg?: string) {
    const workspacePath = workspacePathArg ?? get().workspacePath
    if (!workspacePath || !isTauri()) return

    const status = await getDaemonRuntime(encodeWorkspaceId(workspacePath))
    if (!status) return

    const dismissedAt = get().dismissedAt
    const incomingDetectedAt = status.refresh.last_detected_at
    const shouldClearDismiss =
      incomingDetectedAt != null && dismissedAt != null && incomingDetectedAt !== dismissedAt

    set({
      workspacePath,
      refresh: status.refresh,
      dismissedAt: shouldClearDismiss ? null : dismissedAt,
    })
    schedulePoll(pollIntervalFor(status.refresh.status))
  },
}))
