import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Users } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { InviteActorDialog } from '@/components/sidebar/InviteActorDialog'
import { cn } from '@/lib/utils'
import { NAV_ROW_TRAILING_SLOT } from '@/components/sidebar/nav-row'

export function ContactsNavEntry() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const [inviteOpen, setInviteOpen] = React.useState(false)

  const active = filter.kind === 'actors'
  const inviteLabel = t('invite.title', 'Invite to team')

  return (
    <>
      <div
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-[9px] py-[7px] transition-[background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
          active
            ? 'bg-paper shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
            : 'hover:bg-black/[0.04]',
        )}
      >
        <button
          type="button"
          onClick={() => setFilter({ kind: 'actors' })}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 text-left text-[13px] transition-colors duration-150',
            active ? 'font-semibold text-foreground' : 'font-normal text-ink-2',
          )}
        >
          <Users
            className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
          />
          <span className="min-w-0 flex-1 truncate">{t('sidebar.contacts', 'Contacts')}</span>
        </button>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          title={inviteLabel}
          aria-label={inviteLabel}
          className={cn(
            NAV_ROW_TRAILING_SLOT,
            'text-muted-foreground transition-[background-color,color] duration-150 hover:bg-black/[0.04] hover:text-foreground',
          )}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      </div>
      <InviteActorDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  )
}
