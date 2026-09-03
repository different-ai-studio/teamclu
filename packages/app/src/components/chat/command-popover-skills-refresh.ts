import type { DaemonRuntimeRefresh } from '@/lib/daemon/daemon-local-client'

export function shouldReloadPickerFromDaemonRefresh(
  refresh: DaemonRuntimeRefresh | null | undefined,
  lastHandledAt: string | null,
): { reload: boolean; nextHandledAt: string | null } {
  if (!refresh?.change_kinds.includes('skills')) {
    return { reload: false, nextHandledAt: lastHandledAt }
  }
  const detectedAt = refresh.last_detected_at
  if (detectedAt && detectedAt === lastHandledAt) {
    return { reload: false, nextHandledAt: lastHandledAt }
  }
  return { reload: true, nextHandledAt: detectedAt ?? lastHandledAt }
}
