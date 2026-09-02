import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Check, ChevronRight, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSessionStore } from '@/stores/session'
import type { Question } from '@/stores/session-types'
import { ToolCallDisclosure } from './tool-calls/ToolCallDisclosure'

interface QuestionCardProps {
  toolCallId: string
  questions?: Question[] | unknown
  isCompleted?: boolean
}

export const QuestionCard = React.memo(function QuestionCard({ toolCallId, questions, isCompleted }: QuestionCardProps) {
  const { t } = useTranslation()
  const pendingQuestions = useSessionStore(s => s.pendingQuestions)
  const answeredSnapshot = useSessionStore(
    (s) => s.answeredQuestionsByToolCallId?.[toolCallId],
  )
  const pendingQuestion = pendingQuestions.find(q => q.toolCallId === toolCallId)
  const propQuestions = Array.isArray(questions) ? (questions as Question[]) : []
  // Tool-call arguments may lag or omit questions; the question.asked event
  // (pendingQuestion) is authoritative. After answer, read the local snapshot.
  const questionList: Question[] = propQuestions.length
    ? propQuestions
    : pendingQuestion?.questions?.length
      ? ((pendingQuestion.questions ?? []) as Question[])
      : ((answeredSnapshot?.questions ?? []) as Question[])
  const answerQuestion = useSessionStore(s => s.answerQuestion)
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [customInputs, setCustomInputs] = React.useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [hasSubmitted, setHasSubmitted] = React.useState(false)

  const isPending = !!pendingQuestion
  // questionId arrives via question.asked SSE event (may lag behind tool executing event)
  const hasQuestionId = !!pendingQuestion?.questionId
  // Show as waiting for completion if submitted but not yet completed
  const isWaitingForCompletion = hasSubmitted && !isCompleted

  const handleOptionSelect = (questionIndex: number, option: string) => {
    const questionId = questionList[questionIndex]?.id || String(questionIndex)
    setAnswers(prev => ({ ...prev, [questionId]: option }))
  }

  const handleCustomInput = (questionIndex: number, value: string) => {
    const questionId = questionList[questionIndex]?.id || String(questionIndex)
    setCustomInputs(prev => ({ ...prev, [questionId]: value }))
  }

  const handleSubmit = async () => {
    // Merge selected options with custom inputs (custom input takes precedence if filled)
    const finalAnswers: Record<string, string> = {}
    questionList.forEach((q, idx) => {
      const questionId = q.id || String(idx)
      const customInput = customInputs[questionId]?.trim()
      if (customInput) {
        finalAnswers[questionId] = customInput
      } else if (answers[questionId]) {
        finalAnswers[questionId] = answers[questionId]
      }
    })

    if (Object.keys(finalAnswers).length === 0) return

    setIsSubmitting(true)
    try {
      await answerQuestion(finalAnswers, pendingQuestion?.questionId)
      setHasSubmitted(true)
    } finally {
      setIsSubmitting(false)
    }
  }

  const hasAllAnswers =
    questionList.length > 0 &&
    questionList.every((q, idx) => {
      const questionId = q.id || String(idx)
      return answers[questionId] || customInputs[questionId]?.trim()
    })
  
  // Determine if we should show the interactive UI (options to select)
  const showInteractiveUI = isPending && !hasSubmitted
  const firstQuestion = questionList[0]
  const savedAnswers = answeredSnapshot?.answers ?? {}
  const stateLabel = isCompleted
    ? t('chat.toolCall.question.answered', 'Answered')
    : isWaitingForCompletion
      ? t('chat.toolCall.question.processingAnswer', 'Processing answer...')
      : isPending
        ? t('chat.toolCall.question.waitingForResponse', 'Waiting for response...')
        : undefined

  return (
    <ToolCallDisclosure
      testId="question-card"
      icon={<HelpCircle className="h-3.5 w-3.5" />}
      title={t('chat.toolCall.question.title', 'Question')}
      target={firstQuestion?.header || firstQuestion?.question}
      meta={stateLabel}
      status={isCompleted ? <Check className="h-3 w-3 text-green-600" /> : undefined}
      defaultOpen={questionList.length > 0}
    >
      {/* Questions */}
      <div className="space-y-4 px-3 py-3">
        {questionList.map((question, qIndex) => {
          const questionId = question.id || String(qIndex)
          const selectedOption = answers[questionId] ?? savedAnswers[questionId]
          const customInput = customInputs[questionId] || ''
          const savedAnswer = savedAnswers[questionId]
          const displayAnswer = customInput || selectedOption || savedAnswer

          return (
            <div key={questionId} className="space-y-1.5">
              {/* Question header and text */}
              {question.header && (
                <div className="text-sm font-medium text-foreground">
                  {question.header}
                </div>
              )}
              <div className="text-sm text-muted-foreground mb-2">
                {question.question}
              </div>

              {/* Options */}
              {showInteractiveUI && question.options && question.options.length > 0 &&
                question.options.map((option: any, optIndex: number) => {
                  const optionValue = option.value || option.label
                  const isSelected = selectedOption === optionValue

                  return (
                    <button
                      key={optIndex}
                      onClick={() => handleOptionSelect(qIndex, optionValue)}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md border text-left transition-colors',
                        isSelected
                          ? 'border-foreground/20 bg-muted/40 text-foreground'
                          : 'border-border/70 hover:border-foreground/15'
                      )}
                      disabled={isCompleted || isSubmitting}
                    >
                      <div
                        className={cn(
                          'flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors',
                          isSelected
                            ? 'border-foreground/60 bg-foreground/10'
                            : 'border-muted-foreground/50'
                        )}
                      >
                        {isSelected && <Check className="h-2.5 w-2.5 text-foreground" />}
                      </div>
                      <span className="text-sm flex-1">{option.label}</span>
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 transition-opacity',
                          isSelected ? 'opacity-100 text-foreground/70' : 'opacity-0'
                        )}
                      />
                    </button>
                  )
                })
              }

              {/* Text input - always shown when interactive */}
              {showInteractiveUI && (
                <div className="pt-1">
                  <Input
                    type="text"
                    placeholder={
                      question.options?.length
                        ? t('chat.toolCall.question.customAnswerPlaceholder', 'Or type a custom answer...')
                        : t('chat.toolCall.question.answerPlaceholder', 'Type your answer...')
                    }
                    value={customInput}
                    onChange={(e) => handleCustomInput(qIndex, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && hasAllAnswers) {
                        e.preventDefault()
                        handleSubmit()
                      }
                    }}
                    disabled={isCompleted || isSubmitting}
                    className="text-sm"
                  />
                </div>
              )}

              {/* Show selected answer for completed or submitted questions */}
              {(isCompleted || isWaitingForCompletion) && displayAnswer && (
                <div className="px-4 py-2 rounded-lg bg-muted/30 text-sm">
                  <span className="text-muted-foreground">
                    {t('chat.toolCall.question.answerLabel', 'Answer: ')}
                  </span>
                  <span className="font-medium">{displayAnswer}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Submit button */}
      {showInteractiveUI && (
        <div className="px-3 pb-3">
          <Button
            onClick={handleSubmit}
            disabled={!hasAllAnswers || isSubmitting || !hasQuestionId}
            className="w-full gap-2"
            size="sm"
          >
            <Send className="h-3.5 w-3.5" />
            {isSubmitting
              ? t('chat.toolCall.question.submitting', 'Submitting...')
              : !hasQuestionId
                ? t('chat.toolCall.question.preparing', 'Preparing...')
                : t('chat.toolCall.question.submitAnswer', 'Submit Answer')}
          </Button>
        </div>
      )}
    </ToolCallDisclosure>
  )
});
