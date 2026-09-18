import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Check, Loader2, Pencil, RefreshCw, Search, X } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { usePlatformOperator } from '@/lib/admin/platform-operator'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import type { AdminOrg } from '@/lib/backend/types'
import { SectionHeader, SettingCard } from './shared'
import { OperatorOnly, fmtDate } from './operator-shared'

/**
 * Orgs of this deployment — operators only.
 *
 * An org is the permission boundary (roles live on it, teams inherit them), so
 * this is the top of the operator's map: how many teams and people are inside,
 * and the two fields the console may change. Everything else on the row is
 * owned by another product on the Belayo deployment, which is why renaming and
 * taking out of service is all there is here.
 */

const PAGE = 25

export function OperatorOrgsSection() {
  const { t } = useTranslation()
  const { loading: whoamiLoading, operator, userId } = usePlatformOperator()
  const openOperatorTeams = useUIStore((s) => s.openOperatorTeams)

  const [orgs, setOrgs] = useState<AdminOrg[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const out = await getBackend().admin.listOrgs({ query, limit: PAGE, offset: page * PAGE })
      setOrgs(out.items)
      setTotal(out.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [query, page])

  useEffect(() => {
    if (operator) void load()
  }, [operator, load])

  const save = useCallback(
    async (org: AdminOrg, patch: { name?: string; status?: 'active' | 'inactive' }) => {
      setBusy(true)
      setError(null)
      try {
        const updated = await getBackend().admin.updateOrg(org.id, patch)
        setOrgs((prev) => prev.map((o) => (o.id === org.id ? { ...o, ...updated } : o)))
        setEditing(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const header = (
    <SectionHeader
      icon={Building2}
      title={t('settings.operatorOrgs.title', '组织')}
      description={t(
        'settings.operatorOrgs.description',
        'Every org on this deployment, newest first. Roles live on the org and its teams inherit them, so this is where a tenant begins. Member counts are distinct people across the org’s teams.',
      )}
    />
  )

  if (whoamiLoading || !operator) {
    return <OperatorOnly header={header} loading={whoamiLoading} userId={userId} />
  }

  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <div className="space-y-6">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">{header}</div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('settings.operatorOrgs.refresh', 'Refresh')}
          className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-[7px] border border-border bg-paper px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('settings.operatorOrgs.refresh', 'Refresh')}
        </button>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(0)
          setQuery(term.trim())
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-border bg-paper px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={t('settings.operatorOrgs.searchHint', 'Name or code')}
            aria-label={t('settings.operatorOrgs.search', 'Search orgs')}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
        </div>
        <button
          type="submit"
          className="shrink-0 rounded-[7px] border border-border bg-paper px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
        >
          {t('settings.operatorOrgs.search', 'Search orgs')}
        </button>
      </form>

      {error && (
        <SettingCard>
          <p className="text-[12.5px] text-destructive" role="alert">
            {error}
          </p>
        </SettingCard>
      )}

      <SettingCard className="p-0">
        <div className="divide-y divide-border-soft">
          {orgs.length === 0 && !loading && (
            <p className="p-4 text-[12.5px] text-muted-foreground">
              {t('settings.operatorOrgs.empty', 'No org matches.')}
            </p>
          )}
          {orgs.map((org) => (
            <div key={org.id} className="flex items-start gap-3 p-4" data-testid={`operator-org-${org.id}`}>
              <div className="min-w-0 flex-1">
                {editing === org.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void save(org, { name: draftName.trim() })
                    }}
                  >
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      aria-label={t('settings.operatorOrgs.name', 'Org name')}
                      className="min-w-0 flex-1 rounded-[6px] border border-border bg-background px-2 py-1 text-[13px] outline-none"
                    />
                    <button
                      type="submit"
                      disabled={busy || !draftName.trim()}
                      aria-label={t('settings.operatorOrgs.save', 'Save')}
                      className="rounded-[6px] border border-border bg-paper p-1 text-muted-foreground hover:bg-selected hover:text-foreground disabled:opacity-40"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      aria-label={t('settings.operatorOrgs.cancel', 'Cancel')}
                      className="rounded-[6px] border border-border bg-paper p-1 text-muted-foreground hover:bg-selected hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-foreground">{org.name}</span>
                    {org.status !== 'active' && (
                      <span className="shrink-0 rounded-[4px] border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                        {org.status ?? '—'}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(org.id)
                        setDraftName(org.name)
                      }}
                      aria-label={t('settings.operatorOrgs.rename', 'Rename')}
                      className="shrink-0 rounded-[6px] p-1 text-faint transition-colors hover:bg-selected hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </div>
                )}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                  {org.code && <span className="font-mono text-[11px] text-faint">{org.code}</span>}
                  <span>{t('settings.operatorOrgs.teams', '{{n}} teams', { n: org.teamCount })}</span>
                  <span>·</span>
                  <span>{t('settings.operatorOrgs.members', '{{n}} people', { n: org.memberCount })}</span>
                  <span>·</span>
                  <span className="font-mono text-[11px] text-faint">{fmtDate(org.createdAt)}</span>
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <button
                  type="button"
                  onClick={() => openOperatorTeams(org.id)}
                  className="rounded-[7px] border border-border bg-paper px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
                >
                  {t('settings.operatorOrgs.viewTeams', 'Teams and credits')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(org, { status: org.status === 'active' ? 'inactive' : 'active' })}
                  className="rounded-[7px] px-2.5 py-1 text-[11px] text-faint transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
                >
                  {org.status === 'active'
                    ? t('settings.operatorOrgs.deactivate', 'Take out of service')
                    : t('settings.operatorOrgs.activate', 'Put back in service')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </SettingCard>

      <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
        <span>
          {t('settings.operatorOrgs.total', '{{n}} orgs', { n: total })}
          {query && ` · ${t('settings.operatorOrgs.filtered', 'filtered')}`}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-[6px] border border-border bg-paper px-2 py-1 disabled:opacity-40"
          >
            {t('settings.operatorOrgs.prev', 'Previous')}
          </button>
          <span className="font-mono text-[11px] text-faint tabular-nums">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-[6px] border border-border bg-paper px-2 py-1 disabled:opacity-40"
          >
            {t('settings.operatorOrgs.next', 'Next')}
          </button>
        </span>
      </div>
    </div>
  )
}
