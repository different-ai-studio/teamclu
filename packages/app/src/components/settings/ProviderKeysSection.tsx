import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import { usePlatformOperator } from '@/lib/admin/platform-operator'
import { cn } from '@/lib/utils'
import type { ProviderPool, ProviderPoolCooldown, ProviderPoolKey } from '@/lib/backend/types'
import { SectionHeader, SettingCard } from './shared'

/**
 * The AI gateway's upstream provider keys — operators only.
 *
 * A provider can hold several keys. When one runs out of balance or quota the
 * gateway benches it and serves from the next, so a dead key never surfaces as
 * a failed request: this screen is where it surfaces instead, and where a key
 * is put back into service after the account behind it is funded.
 *
 * Counters and cooldowns live in the gateway process's memory and start empty
 * when it restarts — they are a live view, not history.
 */

/** A cooldown that is still holding the key back, rather than an expired record. */
const activeCooldowns = (key: ProviderPoolKey) => key.cooldowns.filter((c) => c.active)

const hasActive = (pool: ProviderPool) => pool.keys.some((k) => activeCooldowns(k).length > 0)

/**
 * Status dot colors follow the tool-call card (AGENTS.md §3): green serving,
 * amber for something that clears by itself, destructive for what needs a
 * person. Coral is reserved for the brand accent and stays out of this screen.
 */
/**
 * Fallback wording for the bench reason. The locale files carry the real
 * strings; these keep the row readable when a translation is missing, which is
 * what shipping the raw `exhausted` / `rate_limited` would not do.
 */
const CLASS_LABEL: Record<ProviderPoolCooldown['class'], string> = {
  exhausted: 'out of balance or quota',
  rate_limited: 'throttled',
  invalid: 'key rejected',
}

const DOT: Record<ProviderPoolCooldown['class'] | 'serving', string> = {
  serving: '#2eb872',
  rate_limited: '#e8b54a',
  exhausted: 'var(--destructive)',
  invalid: 'var(--destructive)',
}

function fmtClock(iso: string | null): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Whole minutes, then seconds — a cooldown is minutes long, not hours. */
function fmtLeft(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const total = Math.ceil(ms / 1000)
  return total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`
}

export function ProviderKeysSection() {
  const { t } = useTranslation()
  const { loading: whoamiLoading, operator, userId } = usePlatformOperator()

  const [pools, setPools] = useState<ProviderPool[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gatewayMissing, setGatewayMissing] = useState(false)
  const [resetting, setResetting] = useState<string | null>(null)
  /** Snapshots are read against this, so the countdowns match the fetch. */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setGatewayMissing(false)
    try {
      setPools(await getBackend().admin.getProviderPools())
      setFetchedAt(Date.now())
    } catch (e) {
      // A deployment with no AI gateway is a state to explain, not a failure to
      // report: nothing is broken, the feature is simply not configured here.
      if (e instanceof CloudApiError && e.code === 'ai_gateway_unavailable') {
        setGatewayMissing(true)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      setPools(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (operator) void load()
  }, [operator, load])

  const reset = useCallback(
    async (providerId: string, keyId?: string) => {
      setResetting(keyId ?? providerId)
      setError(null)
      try {
        await getBackend().admin.resetProviderPool(providerId, keyId)
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setResetting(null)
      }
    },
    [load],
  )

  const header = (
    <SectionHeader
      icon={KeyRound}
      title={t('settings.providerKeys.title', 'AI 供应商 Key')}
      description={t(
        'settings.providerKeys.description',
        'Upstream keys of this deployment’s AI gateway. A key that runs out of balance or quota is benched and the next one serves, so this is where a dead key shows up. Live state from one gateway process: it starts empty when the gateway restarts.',
      )}
    />
  )

  if (whoamiLoading) {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex h-20 items-center justify-center" data-testid="provider-keys-loading">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Not an operator. Showing the user's own id is the point of the screen for
  // them: it is the value the deployment's PLATFORM_OPERATOR_USER_IDS lists.
  if (!operator) {
    return (
      <div className="space-y-6">
        {header}
        <SettingCard data-testid="provider-keys-not-operator">
          <p className="text-[12.5px] text-ink-2">
            {t(
              'settings.providerKeys.operatorsOnly',
              'Only platform operators of this deployment can see the provider keys.',
            )}
          </p>
          {userId && (
            <p className="mt-3 text-[11.5px] text-muted-foreground">
              {t('settings.providerKeys.yourUserId', 'Your user id')}:{' '}
              <span className="select-all font-mono text-[11.5px] text-ink-2">{userId}</span>
            </p>
          )}
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">{header}</div>
        <div className="mt-1 flex shrink-0 items-center gap-2">
          {fetchedAt !== null && (
            <span className="font-mono text-[11px] text-faint tabular-nums">{fmtClock(new Date(fetchedAt).toISOString())}</span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t('settings.providerKeys.refresh', 'Refresh')}
            className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-paper px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('settings.providerKeys.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {error && (
        <SettingCard>
          <p className="text-[12.5px] text-destructive" role="alert">
            {error}
          </p>
        </SettingCard>
      )}

      {gatewayMissing && (
        <SettingCard data-testid="provider-keys-no-gateway">
          <p className="text-[12.5px] text-ink-2">
            {t(
              'settings.providerKeys.noGateway',
              'This deployment has no AI gateway configured, so it holds no provider keys.',
            )}
          </p>
        </SettingCard>
      )}

      {pools?.length === 0 && !gatewayMissing && (
        <SettingCard>
          <p className="text-[12.5px] text-muted-foreground">
            {t('settings.providerKeys.empty', 'The gateway catalog lists no providers.')}
          </p>
        </SettingCard>
      )}

      {pools?.map((pool) => (
        <SettingCard key={pool.providerId} className="p-4" data-testid={`provider-pool-${pool.providerId}`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-[13px] font-semibold text-foreground">{pool.providerId}</span>
              <span className="text-[11.5px] text-faint">
                {t('settings.providerKeys.keyCount', '{{n}} keys', { n: pool.keys.length })}
              </span>
            </div>
            {hasActive(pool) && (
              <button
                type="button"
                onClick={() => void reset(pool.providerId)}
                disabled={resetting !== null}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[7px] border border-border bg-paper px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
              >
                {resetting === pool.providerId ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                {t('settings.providerKeys.resetAll', 'Resume all')}
              </button>
            )}
          </div>

          <div className="divide-y divide-border-soft">
            {pool.keys.map((key) => {
              const active = activeCooldowns(key)
              const worst = active[0] ?? null
              return (
                <div key={key.id} className="flex items-start gap-3 py-2.5" data-testid={`provider-key-${key.id}`}>
                  <span
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: DOT[worst?.class ?? 'serving'] }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px] text-foreground">{key.hint}</span>
                      <span className="font-mono text-[10.5px] text-faint">{key.id}</span>
                      <span className="text-[10.5px] text-faint">
                        {t('settings.providerKeys.position', 'priority {{n}}', { n: key.position + 1 })}
                      </span>
                    </div>
                    {active.length === 0 ? (
                      <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                        {t('settings.providerKeys.serving', 'Serving')}
                      </p>
                    ) : (
                      active.map((c) => (
                        <p
                          key={`${c.model ?? '*'}-${c.at}`}
                          className="mt-0.5 text-[11.5px] text-ink-2"
                          data-testid={`provider-key-cooldown-${key.id}`}
                        >
                          {t(`settings.providerKeys.class.${c.class}`, CLASS_LABEL[c.class] ?? c.class)}
                          {' · '}
                          {c.model
                            ? t('settings.providerKeys.scopeModel', 'model {{model}}', { model: c.model })
                            : t('settings.providerKeys.scopeKey', 'whole key')}
                          {' · '}
                          <span className="font-mono tabular-nums">
                            {t('settings.providerKeys.resumesIn', 'resumes in {{left}}', {
                              left: fmtLeft(c.until, fetchedAt ?? Date.now()),
                            })}
                          </span>
                          {c.strikes > 1 && (
                            <>
                              {' · '}
                              {t('settings.providerKeys.strikes', '{{n}} in a row', { n: c.strikes })}
                            </>
                          )}
                          {' · '}
                          <span className="font-mono">{c.status}</span>
                          {c.error && <span className="text-faint"> {c.error.slice(0, 120)}</span>}
                        </p>
                      ))
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      {key.ok} / {key.failed}
                    </p>
                    <p className="font-mono text-[10.5px] text-faint tabular-nums">{fmtClock(key.lastUsedAt)}</p>
                  </div>
                  {active.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void reset(pool.providerId, key.id)}
                      disabled={resetting !== null}
                      aria-label={t('settings.providerKeys.resetKey', 'Resume this key')}
                      className="shrink-0 rounded-[7px] border border-border bg-paper px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
                    >
                      {resetting === key.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        t('settings.providerKeys.resetKey', 'Resume this key')
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <p className="mt-3 text-[10.5px] text-faint">
            {t('settings.providerKeys.countsLegend', 'ok / failed calls since the gateway started, and when the key was last used.')}
          </p>
        </SettingCard>
      ))}
    </div>
  )
}
