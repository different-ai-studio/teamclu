import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTelemetryStore } from '@/stores/telemetry'
import type { FeedbackRating } from '@/lib/telemetry/types'

interface MessageFeedbackProps {
  sessionId: string
  messageId: string
}

const feedbackBtnBase =
  'inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] bg-transparent transition-colors hover:bg-selected'

export function MessageFeedback({ sessionId, messageId }: MessageFeedbackProps) {
  const { t } = useTranslation()
  const setFeedback = useTelemetryStore((s) => s.setFeedback)
  const removeFeedback = useTelemetryStore((s) => s.removeFeedback)
  const feedbackCache = useTelemetryStore((s) => s.feedbackCache)

  const currentRating = feedbackCache.get(messageId) as FeedbackRating | undefined
  const [clickPop, setClickPop] = React.useState<FeedbackRating | null>(null)
  const popTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (popTimerRef.current) clearTimeout(popTimerRef.current)
    }
  }, [])

  const playClickPop = React.useCallback((rating: FeedbackRating) => {
    setClickPop(rating)
    if (popTimerRef.current) clearTimeout(popTimerRef.current)
    popTimerRef.current = setTimeout(() => setClickPop(null), 450)
  }, [])

  const handleClick = React.useCallback(
    async (rating: FeedbackRating) => {
      playClickPop(rating)
      if (currentRating === rating) {
        await removeFeedback(sessionId, messageId)
      } else {
        await setFeedback(sessionId, messageId, rating)
      }
    },
    [currentRating, sessionId, messageId, setFeedback, removeFeedback, playClickPop],
  )

  const isRated = currentRating !== undefined

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 transition-opacity duration-200',
        isRated ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100',
      )}
    >
      <button
        type="button"
        onClick={() => void handleClick('positive')}
        aria-pressed={currentRating === 'positive'}
        aria-label={t('chat.feedback.goodResponse')}
        title={t('chat.feedback.goodResponse')}
        className={cn(
          feedbackBtnBase,
          currentRating === 'positive'
            ? 'text-[#2eb872] hover:text-[#2eb872]'
            : 'text-muted-foreground/50 hover:text-ink-2',
          clickPop === 'positive' && 'message-feedback-click-pop',
        )}
      >
        <ThumbsUp className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => void handleClick('negative')}
        aria-pressed={currentRating === 'negative'}
        aria-label={t('chat.feedback.poorResponse')}
        title={t('chat.feedback.poorResponse')}
        className={cn(
          feedbackBtnBase,
          currentRating === 'negative'
            ? 'text-red-500 hover:text-red-500'
            : 'text-muted-foreground/50 hover:text-ink-2',
          clickPop === 'negative' && 'message-feedback-click-pop',
        )}
      >
        <ThumbsDown className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  )
}
