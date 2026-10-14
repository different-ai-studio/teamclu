import { useTranslation } from 'react-i18next'
import { Loader2, SlidersHorizontal } from 'lucide-react'
import type { QuickChatState } from '@/hooks/use-quick-chat-readiness'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type NewChatSplitButtonProps = {
  quickChatState: QuickChatState
  creating: boolean
  onPrimaryClick: () => void
}

function isPrimaryDisabled(state: QuickChatState, creating: boolean): boolean {
  if (creating) return true
  return (
    state.kind === 'no_team'
    || state.kind === 'no_agent'
    || state.kind === 'loading'
  )
}

export function NewChatSplitButton({
  quickChatState,
  creating,
  onPrimaryClick,
}: NewChatSplitButtonProps) {
  const { t } = useTranslation()

  const primaryDisabled = isPrimaryDisabled(quickChatState, creating)
  const primaryTitle =
    quickChatState.kind === 'no_agent'
      ? t(
          'chat.quickSessionNoAgentHint',
          'Set a personal default agent, or ask admin for a team default.',
        )
      : undefined

  const advancedLabel = t('chat.advancedSession', 'Advanced session')

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full overflow-hidden rounded-[10px] bg-coral shadow-[0_4px_14px_rgba(232,90,74,0.22)]">
        <button
          type="button"
          onClick={onPrimaryClick}
          disabled={primaryDisabled}
          title={primaryTitle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-none px-3 py-2.5 text-left text-[13px] font-semibold tracking-tight text-coral-foreground transition-[filter,background-color] duration-150',
            'hover:brightness-[1.04] disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {creating ? (
            <Loader2 className="h-[14px] w-[14px] shrink-0 animate-spin" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{t('chat.newChat', 'New Chat')}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] font-medium tracking-tight text-white/70">
            ⌘N
          </span>
        </button>
        {/*
          Never disabled, unlike the primary half. This is the escape hatch:
          with no default agent the quick button is dead, and the advanced
          dialog — where a participant is picked by hand — is the only way to
          start a chat at all. `no_team` opens it too and lands on its empty
          state, which says what to do about it.
        */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={advancedLabel}
              data-testid="new-chat-advanced"
              onClick={() => useUIStore.getState().openNewSessionDialog()}
              className={cn(
                'flex w-9 shrink-0 items-center justify-center rounded-none border-l border-white/15 text-coral-foreground transition-[filter,background-color] duration-150',
                'hover:brightness-[1.04]',
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{advancedLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
