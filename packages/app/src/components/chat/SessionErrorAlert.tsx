import { useState } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, RefreshCw, AlertTriangle, ShieldAlert, Timer, Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@/lib/utils'
import {
  isAgentTurnAbortError,
  isQuotaLikeAgentMessage,
  TURN_INTERRUPTED_ERROR_NAME,
} from '@/lib/agent/agent-turn-error'
import type { SessionErrorEvent } from '@/stores/session-types'

interface SessionErrorAlertProps {
  error: SessionErrorEvent | string
  onDismiss?: () => void
  onRetry?: () => void
}

interface ErrorStyle {
  icon: typeof AlertCircle
  title: string
  accentColor: string
  iconBg: string
  bodyBg: string
  bodyBorder: string
}

const DEFAULT_BODY_STYLE = {
  bodyBg: 'bg-red-50/80 dark:bg-red-950/20',
  bodyBorder: 'border-red-200/50 dark:border-red-800/30',
}

export function SessionErrorAlert({ error, onDismiss, onRetry }: SessionErrorAlertProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const isStringError = typeof error === 'string'
  const errorName = isStringError ? '' : (error.error?.name || '')
  const rawError = isStringError ? undefined : (error.error as unknown as Record<string, unknown> | undefined)
  const errorMessage = isStringError
    ? error
    : (error.error?.data?.message
      || rawError?.message as string
      || (error as unknown as Record<string, unknown>).message as string
      || '')
  const statusCode = isStringError ? undefined : error.error?.data?.statusCode
  const providerID = isStringError ? undefined : error.error?.data?.providerID
  const isRetryable = isStringError ? false : error.error?.data?.isRetryable

  const isInterrupted =
    errorName === TURN_INTERRUPTED_ERROR_NAME ||
    isAgentTurnAbortError(errorName, errorMessage) ||
    isAgentTurnAbortError(errorMessage)

  if (isInterrupted) {
    // Interrupted turns render via ChatMessage (metadata.turn_status).
    // Do not show a second thread-level stop banner.
    return null
  }

  if (!errorMessage && !errorName) return null

  const isLongMessage = errorMessage.length > 150

  const getErrorStyle = (): ErrorStyle => {
    const lowerMsg = errorMessage.toLowerCase()
    if (errorName === 'AgentTimeoutError') {
      return {
        icon: Timer,
        title: t('errors.modelTimeout', 'Model Not Responding'),
        accentColor: 'text-orange-600 dark:text-orange-400',
        iconBg: 'bg-orange-100 dark:bg-orange-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    if (errorName === 'ProviderError') {
      return {
        icon: AlertTriangle,
        title: t('errors.providerError', 'Provider Error'),
        accentColor: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-100 dark:bg-amber-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    if (
      isQuotaLikeAgentMessage(errorMessage) ||
      lowerMsg.includes('exceeded') ||
      lowerMsg.includes('quota') ||
      lowerMsg.includes('free usage')
    ) {
      return {
        icon: AlertTriangle,
        title: t('errors.quotaExceeded', 'Quota Exceeded'),
        accentColor: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-100 dark:bg-amber-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    if (errorName.includes('auth') || statusCode === 401 || lowerMsg.includes('authentication')) {
      return {
        icon: ShieldAlert,
        title: t('errors.authenticationError', 'Authentication Error'),
        accentColor: 'text-yellow-600 dark:text-yellow-400',
        iconBg: 'bg-yellow-100 dark:bg-yellow-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    if (statusCode === 429) {
      return {
        icon: Timer,
        title: t('errors.rateLimited', 'Rate Limited'),
        accentColor: 'text-orange-600 dark:text-orange-400',
        iconBg: 'bg-orange-100 dark:bg-orange-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    if (statusCode && statusCode >= 500) {
      return {
        icon: AlertCircle,
        title: t('errors.serverError', 'Server Error'),
        accentColor: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-100 dark:bg-red-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    // RetryError just means opencode retried and gave up — the underlying
    // cause (auth, quota, network, ...) is already checked above by message
    // content. Anything left unclassified is still worth flagging, but
    // without implying a specific cause we haven't actually confirmed.
    if (errorName === 'RetryError') {
      return {
        icon: AlertCircle,
        title: t('errors.serviceNotice', 'Service Notice'),
        accentColor: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-100 dark:bg-red-900/40',
        ...DEFAULT_BODY_STYLE,
      }
    }
    return {
      icon: AlertCircle,
      title: t('errors.serviceNotice', 'Service Notice'),
      accentColor: 'text-red-600 dark:text-red-400',
      iconBg: 'bg-red-100 dark:bg-red-900/40',
      ...DEFAULT_BODY_STYLE,
    }
  }

  const style = getErrorStyle()
  const Icon = style.icon

  const displayMessage = !expanded && isLongMessage
    ? errorMessage.slice(0, 150) + '…'
    : errorMessage

  const handleCopy = async () => {
    await copyToClipboard(errorMessage)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex justify-start mb-1.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="max-w-[85%] min-w-0">
        {/* Error header with icon */}
        <div className="flex items-center gap-2 mb-1.5 pl-1">
          <div className={`flex items-center justify-center h-6 w-6 rounded-full ${style.iconBg}`}>
            <Icon className={`h-3.5 w-3.5 ${style.accentColor}`} />
          </div>
          <span className={`text-xs font-semibold ${style.accentColor}`}>{style.title}</span>
          {statusCode && (
            <span className="text-[10px] font-mono text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
              {statusCode}
            </span>
          )}
          {providerID && (
            <span className="text-[10px] text-muted-foreground/60">
              {providerID}
            </span>
          )}
        </div>

        {/* Error message body */}
        <div className={`rounded-2xl border px-4 py-3 ${style.bodyBg} ${style.bodyBorder}`}>
          <p className="text-[13px] leading-relaxed text-foreground/90 break-words [overflow-wrap:anywhere]">
            {displayMessage}
          </p>

          {isLongMessage && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  {t('common.showLess', 'Show less')}
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {t('common.showMore', 'Show more')}
                </>
              )}
            </button>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-1 mt-1.5 pl-1">
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
          </button>

          {isRetryable && onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-primary hover:bg-primary/10 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              {t('common.retry', 'Retry')}
            </button>
          )}

          {onDismiss && (
            <button
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
