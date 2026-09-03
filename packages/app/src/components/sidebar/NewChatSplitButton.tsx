import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Loader2, Plus } from 'lucide-react'
import type { QuickChatState } from '@/hooks/use-quick-chat-readiness'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'

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

function canOpenMore(state: QuickChatState): boolean {
  return state.kind !== 'no_team'
}

export function NewChatSplitButton({
  quickChatState,
  creating,
  onPrimaryClick,
}: NewChatSplitButtonProps) {
  const { t } = useTranslation()
  const [moreOpen, setMoreOpen] = React.useState(false)
  const moreEnabled = canOpenMore(quickChatState)

  const openMultiPersonDialog = () => {
    setMoreOpen(false)
    useUIStore.getState().openNewSessionDialog()
  }

  const primaryDisabled = isPrimaryDisabled(quickChatState, creating)
  const primaryTitle =
    quickChatState.kind === 'no_agent'
      ? t(
          'chat.quickSessionNoAgentHint',
          'Set a personal default agent, or ask admin for a team default.',
        )
      : undefined

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full flex-col overflow-hidden rounded-[10px] shadow-[0_4px_14px_rgba(232,90,74,0.22)]">
        <div className="flex w-full bg-coral">
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
          <button
            type="button"
            disabled={!moreEnabled}
            aria-label={t('chat.newChatMoreOptions', 'More new chat options')}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={cn(
              'flex w-8 shrink-0 items-center justify-center rounded-none border-l border-white/15 text-coral-foreground transition-[filter,background-color] duration-150',
              'hover:brightness-[1.04] disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-200',
                moreOpen && 'rotate-180',
              )}
            />
          </button>
        </div>
        {moreEnabled && (
          <div
            data-testid="new-chat-more-panel-wrap"
            className={cn(
              'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
              moreOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
            aria-hidden={!moreOpen}
          >
            <div className="overflow-hidden">
              <div
                data-testid="new-chat-more-panel"
                className={cn(
                  'border-t border-border-soft bg-paper transition-opacity duration-200 ease-out motion-reduce:transition-none',
                  moreOpen ? 'opacity-100' : 'opacity-0',
                  !moreOpen && 'pointer-events-none',
                )}
              >
                <button
                  type="button"
                  onClick={openMultiPersonDialog}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors',
                    'hover:bg-selected',
                  )}
                >
                  <span
                    className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-coral/10 text-coral"
                    aria-hidden
                  >
                    <Plus className="h-3 w-3" strokeWidth={2.5} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
                    {t('chat.newMultiPersonSession', 'Group session')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
