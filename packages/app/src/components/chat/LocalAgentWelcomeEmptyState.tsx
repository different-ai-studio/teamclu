import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SessionContinueBanner } from '@/components/chat/SessionContinueBanner'
import { useUIStore } from '@/stores/ui'

type LocalAgentWelcomeAgent = {
  id: string
  displayName: string
}

type LocalAgentWelcomeEmptyStateProps = {
  agent: LocalAgentWelcomeAgent | null
  agentLoading?: boolean
  starting?: boolean
  onStartConversation: () => void
  onQuickAction: (message: string) => void
  onOpenAgentSettings: () => void
}

function TextLink({
  children,
  primary,
  disabled,
  onClick,
  className,
  title,
}: {
  children: React.ReactNode
  primary?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'shrink-0 border-none bg-transparent p-0 text-[14px] text-ink-2',
        'underline decoration-border underline-offset-[3px]',
        'transition-colors hover:text-foreground hover:decoration-border',
        'disabled:cursor-not-allowed disabled:opacity-40',
        primary &&
          'font-semibold text-coral no-underline hover:underline hover:decoration-coral',
        className,
      )}
    >
      {children}
    </button>
  )
}

function BlinkCursor() {
  return <span className="terminal-caret" aria-hidden />
}

function StartConversationLink({
  busy,
  starting,
  onStartConversation,
  labelKey,
  labelDefault,
}: {
  busy: boolean
  starting: boolean
  onStartConversation: () => void
  labelKey: string
  labelDefault: string
}) {
  const { t } = useTranslation()

  return (
    <TextLink primary disabled={busy} onClick={onStartConversation}>
      {starting ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t(labelKey, labelDefault)}
        </span>
      ) : (
        <>
          {t(labelKey, labelDefault)}{' '}
          <span className="font-mono text-[12px] font-normal">⌘N</span>
        </>
      )}
    </TextLink>
  )
}

function ExtensionWelcomeEmptyState({
  agent,
  agentLoading = false,
  starting = false,
  onStartConversation,
  onOpenAgentSettings,
}: LocalAgentWelcomeEmptyStateProps) {
  const { t } = useTranslation()
  const ready = !!agent
  const busy = starting || agentLoading

  const statusSub = agentLoading
    ? t('chat.extensionWelcome.statusSubLoading', '● checking…')
    : ready
      ? t('chat.extensionWelcome.statusSubOnline', '● online')
      : t('chat.extensionWelcome.statusSubOffline', '● offline')

  if (agentLoading && !agent) {
    return (
      <div className="flex w-full justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-full text-center">
      <p className="text-[26px] font-medium leading-relaxed tracking-tight text-ink-2">
        {ready ? (
          <span className="inline-flex items-center justify-center">
            <span>{t('chat.extensionWelcome.headline', '随时可以开始')}</span>
            <BlinkCursor />
          </span>
        ) : (
          t('chat.extensionWelcome.headlineOffline', '助手暂不可用')
        )}
      </p>

      <p className="mt-5 font-mono text-[13px] text-faint">{statusSub}</p>

      <div className="mt-4 flex flex-nowrap items-center justify-center whitespace-nowrap">
        {ready ? (
          <StartConversationLink
            busy={busy}
            starting={starting}
            onStartConversation={onStartConversation}
            labelKey="chat.newChat"
            labelDefault="New Chat"
          />
        ) : (
          <TextLink primary onClick={onOpenAgentSettings}>
            {t('chat.openAgentSettings', '打开 Agent 设置')}
          </TextLink>
        )}
      </div>
    </div>
  )
}

export function LocalAgentWelcomeEmptyState(props: LocalAgentWelcomeEmptyStateProps) {
  const embedMode = useUIStore((s) => s.embedMode)
  if (embedMode) {
    return <ExtensionWelcomeEmptyState {...props} />
  }

  return <DesktopLocalAgentWelcomeEmptyState {...props} />
}

function DesktopLocalAgentWelcomeEmptyState({
  agent,
  agentLoading = false,
  starting = false,
  onStartConversation,
  onQuickAction: _onQuickAction,
  onOpenAgentSettings,
}: LocalAgentWelcomeEmptyStateProps) {
  const { t } = useTranslation()
  const ready = !!agent
  const busy = starting || agentLoading
  const agentName =
    agent?.displayName ?? t('chat.localAgentWelcome.fallbackName', '本机 Agent')

  const statusSub = agentLoading
    ? t('chat.localAgentWelcome.statusSubLoading', '● checking…')
    : ready
      ? t('chat.localAgentWelcome.statusSubOnline', '● online · local · ai')
      : t('chat.localAgentWelcome.statusSubOffline', '● offline · local')

  if (agentLoading && !agent) {
    return (
      <div className="flex w-full justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-full text-center">
      <p className="text-[30px] font-medium leading-relaxed tracking-tight text-ink-2">
        {ready ? (
          <span className="inline-flex items-center justify-center">
            <span>
              <span className="font-bold text-foreground">{agentName}</span>{' '}
              {t('chat.localAgentWelcome.headlineSuffix', '在本机等你开口')}
            </span>
            <BlinkCursor />
          </span>
        ) : (
          t('chat.localAgentWelcome.headlineOffline', '本机 Agent 暂不可用')
        )}
      </p>

      <p className="mt-6 font-mono text-[13px] text-faint">{statusSub}</p>

      <div className="mt-4 flex flex-nowrap items-center justify-center gap-x-4 whitespace-nowrap">
        {ready ? (
          <>
            <StartConversationLink
              busy={busy}
              starting={starting}
              onStartConversation={onStartConversation}
              labelKey="chat.newChat"
              labelDefault="New Chat"
            />
            <SessionContinueBanner
              actorId={agent.id}
              actorName={agent.displayName}
              variant="inline"
              className="shrink-0 text-[14px]"
            />
          </>
        ) : (
          <TextLink primary onClick={onOpenAgentSettings}>
            {t('chat.openAgentSettings', '打开 Agent 设置')}
          </TextLink>
        )}
      </div>
    </div>
  )
}
