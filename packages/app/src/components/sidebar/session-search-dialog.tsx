import { useTranslation } from "react-i18next"
import { MessageSquare } from "lucide-react"

import { useSessionStore } from "@/stores/session"
import { useUIStore } from "@/stores/ui"
import { formatRelativeTime } from "@/lib/date-format"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"

// Session search dialog component. Searches the sessions the sidebar lists;
// archived sessions are not searchable here (the legacy archived-session view
// was a stub that only ever showed an error).
export function SessionSearchDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const sessions = useSessionStore(s => s.sessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)

  // Format date for display
  const formatDate = (date: Date) => formatRelativeTime(date)

  const handleSelectSession = (sessionId: string) => {
    useUIStore.getState().switchToSession(sessionId)
    onOpenChange(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sidebar.searchSessions', 'Search Sessions')}
      description={t('sidebar.searchDescription', 'Search and navigate to a session')}
    >
      <CommandInput placeholder={t('sidebar.searchPlaceholder', 'Search sessions...')} />
      <CommandList className="max-h-[400px]">
        <CommandEmpty>{t('sidebar.noSessionsFound', 'No sessions found.')}</CommandEmpty>
        <CommandGroup heading={t('sidebar.sessions', 'Sessions')}>
          {sessions.map((session) => (
            <CommandItem
              key={session.id}
              value={`${session.id} ${session.title}`}
              onSelect={() => handleSelectSession(session.id)}
            >
              <MessageSquare className="h-4 w-4 mr-3 text-muted-foreground shrink-0" />
              <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate font-medium">{session.title}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(session.updatedAt)}
                </span>
              </div>
              {activeSessionId === session.id && (
                <span className="text-xs text-emerald-500 font-medium ml-2 shrink-0">{t('sidebar.active', 'Active')}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
