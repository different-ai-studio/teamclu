import { useMemo } from 'react'
import { Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTeamPermissions } from '@/lib/team/team-permissions'
import { useActorDirectory, type ActorRow } from '@/stores/actor-directory-store'
import { useUIStore } from '@/stores/ui'
import type { CreditErrorReason } from '@/lib/agent/credit-error'

interface CreditErrorAlertProps {
  reason: CreditErrorReason
  onDismiss?: () => void
}

const MAX_NAMED_OWNERS = 3

function isOwnerActor(actor: ActorRow): boolean {
  if (actor.actor_type !== 'member') return false
  if (actor.roles?.some((r) => (r.code ?? '').toLowerCase() === 'owner')) return true
  return (actor.team_role ?? '').toLowerCase() === 'owner'
}

/** Team owners by name — who a member should ask. Topping up and raising a
 *  member quota are both owner-only on the server, so admins are not listed. */
export function useTeamOwnerNames(): string[] {
  const { actors } = useActorDirectory()
  return useMemo(
    () =>
      actors
        .filter(isOwnerActor)
        .map((a) => a.display_name.trim())
        .filter(Boolean)
        .slice(0, MAX_NAMED_OWNERS),
    [actors],
  )
}

/**
 * The AI gateway refused the turn for credits. Says what happened, that a
 * retry will not help, and the one thing that does: an owner gets the button
 * to fix it, everyone else learns who to ask.
 */
export function CreditErrorAlert({ reason, onDismiss }: CreditErrorAlertProps) {
  const { t } = useTranslation()
  const { isOwner } = useTeamPermissions()
  const ownerNames = useTeamOwnerNames()
  const openSettings = useUIStore((s) => s.openSettings)

  const teamWallet = reason === 'insufficient_credits'
  const title = teamWallet
    ? t('errors.insufficientCreditsTitle', "Team AI balance is used up")
    : t('errors.memberQuotaExceededTitle', 'Your AI quota is used up')
  const body = teamWallet
    ? t(
        'errors.insufficientCreditsBody',
        "The team's AI balance is used up, so this turn was not run. It works again as soon as credits are added — no restart needed.",
      )
    : t(
        'errors.memberQuotaExceededBody',
        'Your personal AI quota for this period is used up, so this turn was not run. A team owner can raise your limit.',
      )

  const names = ownerNames.join(t('errors.creditOwnerNameSeparator', ', '))
  const contactHint = teamWallet
    ? names
      ? t('errors.insufficientCreditsContactNamed', 'Ask a team owner to add credits: {{names}}', { names })
      : t('errors.insufficientCreditsContact', 'Ask a team owner to add credits.')
    : names
      ? t('errors.memberQuotaContactNamed', 'Ask a team owner to raise your limit: {{names}}', { names })
      : t('errors.memberQuotaContact', 'Ask a team owner to raise your limit.')

  return (
    <div
      className="flex justify-start mb-1.5 animate-in fade-in slide-in-from-bottom-1 duration-300"
      data-testid="credit-error-alert"
      data-reason={reason}
    >
      <div className="max-w-[85%] min-w-0">
        <div className="flex items-center gap-2 mb-1.5 pl-1">
          <div className="flex items-center justify-center h-6 w-6 rounded-full bg-amber-100 dark:bg-amber-900/40">
            <Wallet className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">{title}</span>
        </div>

        <div className="rounded-2xl border px-4 py-3 bg-amber-50/80 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-800/30">
          <p className="text-[13px] leading-relaxed text-foreground/90 break-words">{body}</p>
          {!isOwner && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground" data-testid="credit-error-contact">
              {contactHint}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1 mt-1.5 pl-1">
          {isOwner && (
            <button
              type="button"
              onClick={() => openSettings(teamWallet ? 'billing' : 'tokenUsage')}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
              data-testid="credit-error-action"
            >
              {teamWallet
                ? t('errors.insufficientCreditsAction', 'Add credits')
                : t('errors.memberQuotaAction', 'Adjust quotas')}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {t('common.dismiss', 'Dismiss')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
