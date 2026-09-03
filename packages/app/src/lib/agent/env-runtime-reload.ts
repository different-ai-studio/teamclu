import type { DaemonApplyOutcome } from '@/lib/daemon/daemon-local-client'

/** User-facing hint after POST /runtime/reload from the env-vars settings flow. */
export function describeEnvReloadOutcome(outcome: DaemonApplyOutcome): string {
  switch (outcome) {
    case 'restart_required':
      return '已停止活跃 runtime。请新开 session 或发送新消息，Agent 才会注入最新环境变量。'
    case 'reload_required':
      return '运行时已重载。下次 spawn 时将使用最新环境变量。'
    case 'applied_live':
      return '运行时已应用最新配置。'
    default:
      return '运行时已重载。'
  }
}
