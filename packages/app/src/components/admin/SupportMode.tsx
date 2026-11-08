import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LifeBuoy, Loader2, LogOut } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import {
  exitSupportSession,
  forgetSupportSession,
  useInSupportSession,
  useSupportSessionStore,
} from '@/lib/admin/support-session'

/** Leave this long before the support session stops refreshing. */
const EXIT_AHEAD_MS = 60_000

function remainingLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/**
 * Keeps support mode recoverable. Mounted outside AuthGate, because the case it
 * exists for is the login screen: the support session expired or was revoked
 * while the app was closed, the session store dropped it, and the operator's
 * own session is still kept locally. It also leaves support mode a minute
 * before the session stops refreshing, and forgets a record that belongs to
 * nobody signed in here.
 */
export function SupportSessionGuard() {
  const record = useSupportSessionStore((s) => s.record)
  const busy = useSupportSessionStore((s) => s.busy)
  const session = useAuthStore((s) => s.session)
  const loading = useAuthStore((s) => s.loading)
  const userId = session?.user?.id ?? null

  useEffect(() => {
    if (!record || busy || loading) return
    if (!userId) {
      void exitSupportSession()
      return
    }
    // Signed in as neither side of the record (another account): stale.
    // Signed in as the operator with a record left over is harmless: it is not
    // support mode (isInSupportSession compares the support account), and the
    // next entry or sign-out replaces it.
    if (userId !== record.supportUserId && userId !== record.operator.userId) {
      forgetSupportSession()
    }
  }, [record, busy, loading, userId])

  useEffect(() => {
    if (!record || userId !== record.supportUserId) return
    const due = new Date(record.expiresAt).getTime() - EXIT_AHEAD_MS - Date.now()
    const timer = setTimeout(() => void exitSupportSession(), Math.max(0, due))
    return () => clearTimeout(timer)
  }, [record, userId])

  return null
}

/** The bar across the top of the shell while acting as a customer org's support account. */
export function SupportModeBanner() {
  const { t } = useTranslation()
  const record = useInSupportSession()
  const busy = useSupportSessionStore((s) => s.busy)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!record) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [record])

  if (!record) return null
  const left = new Date(record.expiresAt).getTime() - now

  return (
    <div
      role="status"
      data-testid="support-mode-banner"
      className="flex shrink-0 items-center gap-2 border-b border-coral/30 bg-coral/10 px-3 py-1.5 text-[12px] text-foreground"
    >
      <LifeBuoy className="h-3.5 w-3.5 shrink-0 text-coral" aria-hidden />
      <span className="min-w-0 truncate">
        {t('supportMode.banner', 'Support mode · acting as TeamClu Support in {{org}} / {{team}}', {
          org: record.orgName ?? record.orgId,
          team: record.team.name || record.team.slug,
        })}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
        {t('supportMode.remaining', '{{left}} left', { left: remainingLabel(left) })}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void exitSupportSession()}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-border bg-paper px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
        {t('supportMode.exit', 'Leave support mode')}
      </button>
    </div>
  )
}
