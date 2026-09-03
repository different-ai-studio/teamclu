/**
 * TestCredentialsButton - Test credentials/token button with loading state and result display.
 * Common pattern across all channel settings.
 */
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface TestResult {
  success: boolean
  message: string
}

export function TestCredentialsButton({
  onTest,
  isTesting,
  testResult,
  onClearResult,
  disabled,
  label,
}: {
  onTest: () => void
  isTesting: boolean
  testResult: TestResult | null
  onClearResult: () => void
  disabled?: boolean
  label?: string
}) {
  const { t } = useTranslation()

  return (
    <>
      <Button
        variant="outline"
        onClick={onTest}
        disabled={isTesting || disabled}
      >
        {isTesting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          label || t('settings.channels.test', 'Test')
        )}
      </Button>
      {testResult && (
        <div className={cn(
          "flex items-start gap-2 text-[13px] mt-2 w-full basis-full",
          testResult.success ? "text-emerald-600" : "text-red-600"
        )}>
          {testResult.success ? (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          )}
          <span className="break-words min-w-0">{testResult.message}</span>
          <Button variant="ghost" size="sm" className="h-4 w-4 p-0 flex-shrink-0" onClick={onClearResult}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </>
  )
}
