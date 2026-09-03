import React from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navigateActiveBrowserTab } from '@/lib/remote-tools/browser-navigate'
import { parsePageNavLinksFromToolCall } from '@/lib/remote-tools/link-utils'
import { TOOL_SHOW_PAGE_NAV_LINKS } from '@/lib/remote-tools/types'
import type { ToolCall } from '@/stores/session-types'
import { ToolCallDisclosure } from './ToolCallDisclosure'
import { ToolCallStatusGlyph } from './ToolCallStatusGlyph'

type PageNavLinksToolCardProps = {
  toolCall: ToolCall
}

export const PageNavLinksToolCard = React.memo(function PageNavLinksToolCard({
  toolCall,
}: PageNavLinksToolCardProps) {
  const { t } = useTranslation()
  const parsed = parsePageNavLinksFromToolCall(
    toolCall.arguments as Record<string, unknown> | undefined,
    toolCall.rawInput,
  )

  if (!parsed) {
    return (
      <div
        data-testid="page-nav-links-tool"
        className="text-[12px] text-muted-foreground px-[10px] py-[6px]"
      >
        {t('chat.toolCall.pageNav.invalid', '无效的导航链接')}
      </div>
    )
  }

  const handleNavigate = (url: string) => {
    void navigateActiveBrowserTab(url).catch((e) => {
      console.warn('[page-nav-links] navigate failed', e)
    })
  }

  return (
    <ToolCallDisclosure
      testId="page-nav-links-tool"
      icon={<ExternalLink className="h-3.5 w-3.5" />}
      title={t('chat.toolCall.pageNav.title', 'Page Links')}
      target={t('chat.toolCall.pageNav.description', 'Show page navigation links')}
      meta={`${parsed.links.length}`}
      status={<ToolCallStatusGlyph status={toolCall.status} />}
    >
      <div
        data-tool-name={TOOL_SHOW_PAGE_NAV_LINKS}
        className="grid grid-cols-2 gap-1.5 p-2.5 max-sm:grid-cols-1"
      >
        {parsed.links.map((link, index) => (
          <button
            key={`${link}-${index}`}
            type="button"
            data-testid="page-nav-link-button"
            data-nav-url={link}
            title={link}
            onClick={() => handleNavigate(link)}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-2',
              'text-left text-[11.5px] text-ink-2',
            )}
          >
            <ExternalLink className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
            <span className="truncate">{parsed.labels[index] ?? link}</span>
          </button>
        ))}
      </div>
    </ToolCallDisclosure>
  )
})
