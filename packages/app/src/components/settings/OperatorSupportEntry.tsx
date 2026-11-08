import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LifeBuoy, Loader2 } from 'lucide-react'
import { enterSupportSession, useSupportSessionStore } from '@/lib/admin/support-session'
import { useUIStore } from '@/stores/ui'
import { SettingCard } from './shared'

/**
 * "Help inside this team" — operators only, on a team's detail page.
 *
 * Enters the team as its org's shared support account ("TeamClu 支持", an org
 * owner) for up to four hours. The customer sees that account in the team like
 * any member; who was behind it is recorded with the reason on the server.
 */
export function OperatorSupportEntry({
  team,
}: {
  team: { id: string; name: string | null; slug: string; orgId: string | null; orgName: string | null }
}) {
  const { t } = useTranslation()
  const busy = useSupportSessionStore((s) => s.busy)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!team.orgId) return null
  const orgId = team.orgId

  const enter = async () => {
    setError(null)
    try {
      await enterSupportSession({
        orgId,
        orgName: team.orgName,
        team: { id: team.id, name: team.name || team.slug, slug: team.slug },
        reason: reason.trim(),
      })
      closeSettings()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <SettingCard>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <LifeBuoy className="h-3.5 w-3.5 text-coral" aria-hidden />
            {t('settings.operatorSupport.title', 'Help inside this team')}
          </p>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            {t(
              'settings.operatorSupport.description',
              'Enter the team as “TeamClu Support”, an owner of its org, for up to 4 hours. The team sees that account as a member; your name and reason are recorded. Your own session is kept on this computer and comes back when you leave.',
            )}
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-[7px] border border-border bg-paper px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
          >
            {t('settings.operatorSupport.start', 'Enter as support')}
          </button>
        )}
      </div>

      {open && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim()) void enter()
          }}
        >
          <label className="block space-y-1">
            <span className="block text-[11.5px] text-muted-foreground">
              {t('settings.operatorSupport.reason', 'Reason (recorded)')}
            </span>
            <input
              autoFocus
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('settings.operatorSupport.reasonHint', 'e.g. ticket number, what the customer asked for')}
              aria-label={t('settings.operatorSupport.reason', 'Reason (recorded)')}
              className="w-full rounded-[6px] border border-border bg-background px-2 py-1 text-[12.5px] outline-none placeholder:text-faint"
            />
          </label>
          {error && (
            <p className="text-[12px] text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              className="rounded-[7px] px-2.5 py-1 text-[11.5px] text-faint transition-colors hover:bg-selected hover:text-foreground"
            >
              {t('settings.operatorSupport.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={busy || !reason.trim()}
              className="inline-flex items-center gap-1.5 rounded-[7px] bg-coral px-3 py-1 text-[11.5px] font-medium text-coral-foreground transition-colors hover:bg-coral/90 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {t('settings.operatorSupport.confirm', 'Enter')}
            </button>
          </div>
        </form>
      )}
    </SettingCard>
  )
}
