import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Terminal, Info } from 'lucide-react'
import { AgentType } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { getKnownLocalDaemonActorId } from '@/lib/daemon/local-daemon-identity'
import { groupAgentModelOptions } from '@/lib/agent/agent-available-models'
import { SectionHeader, SettingCard } from './shared'
import { TeamProviderCard } from './llm/TeamProviderCard'

/**
 * pi LLM settings — deliberately NOT the OpenCode provider UI.
 *
 * pi (@earendil-works/pi-coding-agent) owns its own credential/provider store
 * on the host and is configured with `pi /login`; the daemon has no
 * connect/OAuth/custom-provider path for it. So this pane is read-only: it
 * shows the models the running pi runtime actually exposes (via
 * `get_available_models`, grouped by provider) and points the user at
 * `pi /login` to add providers.
 */
export function PiLLMSection() {
  const { t } = useTranslation()
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)

  // The local daemon's live pi runtime is the source of truth for the model
  // catalog (pi only reports models for configured, logged-in providers).
  const models = React.useMemo(() => {
    const localId = getKnownLocalDaemonActorId()
    let best: { models: { id?: string; displayName?: string }[]; lastUpdated: number } | null = null
    for (const entry of Object.values(byRuntimeId)) {
      if (entry.info.agentType !== AgentType.PI) continue
      if (localId && entry.daemonActorId !== localId) continue
      if (!best || entry.lastUpdated > best.lastUpdated) {
        best = { models: entry.info.availableModels ?? [], lastUpdated: entry.lastUpdated }
      }
    }
    const seen = new Set<string>()
    return (best?.models ?? [])
      .map((m) => ({ id: m.id?.trim() ?? '', displayName: m.displayName?.trim() || m.id?.trim() || '' }))
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
  }, [byRuntimeId])

  const groups = React.useMemo(() => groupAgentModelOptions(models), [models])

  return (
    <div>
      <SectionHeader
        icon={Cpu}
        title={t('settings.piLlm.title', 'Pi 模型')}
        description={t(
          'settings.piLlm.description',
          'pi 运行时自带的模型与 provider，由主机上的 pi 凭证管理。',
        )}
      />

      {/* Pinned above pi's own catalog: the team gateway needs no `pi /login`. */}
      <TeamProviderCard className="mb-4" />

      <SettingCard className="mb-4">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-[12.5px] leading-relaxed text-muted-foreground">
            <p>
              {t(
                'settings.piLlm.loginHint',
                'pi 的 provider 由 pi 自己管理，不通过 opencode.json。要新增或登录 provider，请在主机终端运行：',
              )}
            </p>
            <code className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-panel px-2 py-1 font-mono text-[12px] text-foreground">
              <Terminal className="h-3.5 w-3.5" />
              pi /login
            </code>
            <p className="mt-2">
              {t(
                'settings.piLlm.loginHintAfter',
                '登录后回到这里刷新，新的 provider 模型会自动出现。',
              )}
            </p>
          </div>
        </div>
      </SettingCard>

      {models.length === 0 ? (
        <SettingCard>
          <div className="p-6 text-center text-[12.5px] text-muted-foreground">
            {t(
              'settings.piLlm.empty',
              '暂无可用模型。请确认本机 pi 运行时在线，并已通过 pi /login 配置至少一个 provider。',
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
                    {t('settings.piLlm.modelCount', '{{count}} 个模型', {
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
