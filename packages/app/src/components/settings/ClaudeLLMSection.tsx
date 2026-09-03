import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Terminal, Info } from 'lucide-react'
import { AgentType } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { getKnownLocalDaemonActorId } from '@/lib/daemon/local-daemon-identity'
import { groupAgentModelOptions } from '@/lib/agent/agent-available-models'
import { SectionHeader, SettingCard } from './shared'

/**
 * Claude Code LLM settings — read-only, for the same reason as `PiLLMSection`.
 *
 * The `claude` CLI owns its own credentials on the host (`claude /login`, or a
 * long-lived token from `claude setup-token`); the daemon has no
 * connect/OAuth/custom-provider path for it, so there is nothing to configure
 * here. The pane shows the models the running claude runtime advertises and
 * points at the CLI for auth.
 *
 * Models come from a live `list_models` probe (`Query.supportedModels()`), so
 * the list follows whatever the installed CLI currently supports.
 */
export function ClaudeLLMSection() {
  const { t } = useTranslation()
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)

  const models = React.useMemo(() => {
    const localId = getKnownLocalDaemonActorId()
    let best: { models: { id?: string; displayName?: string }[]; lastUpdated: number } | null = null
    for (const entry of Object.values(byRuntimeId)) {
      if (entry.info.agentType !== AgentType.CLAUDE_CODE) continue
      if (localId && entry.daemonActorId !== localId) continue
      if (!best || entry.lastUpdated > best.lastUpdated) {
        best = { models: entry.info.availableModels ?? [], lastUpdated: entry.lastUpdated }
      }
    }
    const seen = new Set<string>()
    return (best?.models ?? [])
      .map((m) => ({
        id: m.id?.trim() ?? '',
        displayName: m.displayName?.trim() || m.id?.trim() || '',
      }))
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
  }, [byRuntimeId])

  const groups = React.useMemo(() => groupAgentModelOptions(models), [models])

  return (
    <div>
      <SectionHeader
        icon={Cpu}
        title={t('settings.claudeLlm.title', 'Claude Code 模型')}
        description={t(
          'settings.claudeLlm.description',
          'claude 运行时自带的模型，由主机上的 claude 凭证管理。',
        )}
      />

      <SettingCard className="mb-4">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-[12.5px] leading-relaxed text-muted-foreground">
            <p>
              {t(
                'settings.claudeLlm.loginHint',
                'Claude Code 的凭证由 claude CLI 自己管理，不通过 opencode.json。要登录，请在主机终端运行：',
              )}
            </p>
            <code className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-panel px-2 py-1 font-mono text-[12px] text-foreground">
              <Terminal className="h-3.5 w-3.5" />
              claude /login
            </code>
            <p className="mt-2">
              {t(
                'settings.claudeLlm.loginHintAfter',
                '登录后回到这里刷新。若本机未安装 claude 命令，运行时无法启动。',
              )}
            </p>
          </div>
        </div>
      </SettingCard>

      {models.length === 0 ? (
        <SettingCard>
          <div className="p-6 text-center text-[12.5px] text-muted-foreground">
            {t(
              'settings.claudeLlm.empty',
              '暂无可用模型。请确认本机已安装 claude 命令并完成登录，且 claude 运行时在线。',
            )}
          </div>
        </SettingCard>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <SettingCard key={group.providerName}>
              <div className="border-b border-border-soft px-4 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12.5px] font-medium text-foreground">
                    {group.providerName}
                  </span>
                  <span className="text-[11px] text-faint">
                    {t('settings.claudeLlm.modelCount', '{{count}} 个模型', {
                      count: group.models.length,
                    })}
                  </span>
                </div>
              </div>
              <ul className="divide-y divide-border-soft">
                {group.models.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between px-4 py-2.5 text-[12.5px]"
                  >
                    <span className="text-foreground">{m.displayName}</span>
                    <span className="font-mono text-[11px] text-faint">{m.id}</span>
                  </li>
                ))}
              </ul>
            </SettingCard>
          ))}
        </div>
      )}
    </div>
  )
}
