import { LifeBuoy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import { useUIStore } from '@/stores/ui'

export function DiagnoseSessionButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const requestSessionFocus = useDiagnosticsStore((s) => s.requestSessionFocus)
  const openSettings = useUIStore((s) => s.openSettings)

  return (
    <button
      type="button"
      data-testid="diagnose-session-button"
      onClick={() => {
        requestSessionFocus(sessionId)
        openSettings('diagnostics')
      }}
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={t('chat.diagnoseSession', '诊断此会话')}
    >
      <LifeBuoy className="h-3.5 w-3.5" />
    </button>
  )
}
