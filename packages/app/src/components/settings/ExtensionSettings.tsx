import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Puzzle, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppVersion } from '@/lib/version'
import { ExtensionGeneralSection } from './ExtensionGeneralSection'

type ExtensionSettingsSection = 'general'

/** Sidebar collapses to icon-only below this container width (px). */
const EXTENSION_SETTINGS_COMPACT_MAX_WIDTH = 560

interface Section {
  id: ExtensionSettingsSection
  label: string
  labelKey: string
  icon: React.ElementType
}

const extensionSections: Section[] = [
  { id: 'general', label: 'General', labelKey: 'settings.nav.general', icon: Settings2 },
]

const SECTION_COMPONENTS: Record<ExtensionSettingsSection, React.ComponentType> = {
  general: ExtensionGeneralSection,
}

function useCompactNav(threshold = EXTENSION_SETTINGS_COMPACT_MAX_WIDTH) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [compact, setCompact] = React.useState(false)

  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const sync = (width: number) => {
      if (width <= 0) return
      setCompact(width < threshold)
    }
    sync(el.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      sync(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])

  return { rootRef, compact }
}

function ExtensionSettingsBody({
  section,
  compact,
}: {
  section: ExtensionSettingsSection
  compact: boolean
}) {
  const Component = SECTION_COMPONENTS[section]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ScrollArea className="h-full min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div
          className={cn(
            'w-full min-w-0 max-w-[960px]',
            compact ? 'p-4' : 'p-8 pr-10',
          )}
        >
          {React.createElement(Component)}
        </div>
      </ScrollArea>
    </div>
  )
}

function ExtensionNavButton({
  section,
  isActive,
  compact,
  onSelect,
}: {
  section: Section
  isActive: boolean
  compact: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const Icon = section.icon
  const label = t(section.labelKey, section.label)

  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative flex items-center rounded-lg transition-colors',
        compact
          ? 'h-9 w-9 justify-center'
          : 'w-full gap-2.5 px-3 py-2 text-[12px]',
        isActive
          ? 'bg-selected font-semibold text-foreground'
          : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground',
      )}
    >
      <Icon
        className={cn(
          'transition-colors',
          compact ? 'h-4 w-4' : 'h-3.5 w-3.5',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      />
      {!compact ? <span>{label}</span> : null}
    </button>
  )
}

/** Settings shell for Chrome extension / plugin embed mode — separate from desktop Client settings. */
export function ExtensionSettings() {
  const { t } = useTranslation()
  const appVersion = useAppVersion()
  const { rootRef, compact } = useCompactNav()
  const [activeView, setActiveView] = React.useState<ExtensionSettingsSection>('general')
  const [expanded, setExpanded] = React.useState(true)

  return (
    <div
      ref={rootRef}
      className="flex h-full bg-background text-foreground"
      data-testid={compact ? 'extension-settings-compact' : 'extension-settings-wide'}
    >
      <div
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-background',
          compact ? 'w-12' : 'w-60',
        )}
      >
        <ScrollArea className="flex-1 overflow-hidden py-3">
          <div className={cn(compact ? 'flex flex-col items-center gap-1 px-1' : 'space-y-0.5 px-2')}>
            {compact ? (
              extensionSections.map((section) => (
                <ExtensionNavButton
                  key={section.id}
                  section={section}
                  isActive={activeView === section.id}
                  compact
                  onSelect={() => setActiveView(section.id)}
                />
              ))
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => !prev)}
                  className={cn(
                    'relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors',
                    expanded
                      ? 'bg-selected font-semibold text-foreground'
                      : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground',
                  )}
                >
                  <Puzzle
                    className={cn(
                      'h-4 w-4 transition-colors',
                      expanded ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  {t('settings.nav.extension', 'Extension')}
                  <ChevronDown
                    className={cn(
                      'ml-auto h-4 w-4 transition-transform duration-200',
                      expanded ? 'rotate-180' : '',
                    )}
                  />
                </button>
                <div
                  className={cn(
                    'grid transition-[grid-template-rows] duration-200 ease-out',
                    expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                  aria-hidden={!expanded}
                >
                  <div className="overflow-hidden">
                    <div
                      className={cn('mt-1 space-y-0.5 pl-6', !expanded && 'pointer-events-none')}
                      data-testid="extension-subnav"
                    >
                      {extensionSections.map((section) => (
                        <ExtensionNavButton
                          key={section.id}
                          section={section}
                          isActive={activeView === section.id}
                          compact={false}
                          onSelect={() => setActiveView(section.id)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {!compact ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="cursor-default select-none font-mono text-[11px] text-faint">
              v{appVersion}
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <ExtensionSettingsBody section={activeView} compact={compact} />
      </div>
    </div>
  )
}
