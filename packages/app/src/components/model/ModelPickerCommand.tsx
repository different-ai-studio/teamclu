import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  groupAgentModelOptions,
  type AgentModelOption,
} from '@/lib/agent-available-models'
import { cn } from '@/lib/utils'

interface ModelPickerCommandProps {
  /** Flat, provider-grouped-on-render model list. Searched + grouped inside. */
  models: AgentModelOption[]
  /** Currently selected model id (empty string = nothing selected). */
  selectedId?: string
  /** Called with the picked model id when a row is chosen. */
  onSelect: (id: string) => void
  /** Override selection test (e.g. chat normalizes ids); defaults to `id === selectedId`. */
  isSelected?: (id: string) => boolean
  /**
   * Replaces the whole list (and hides search) when provided — for
   * caller-owned states like offline / loading that aren't just "empty".
   */
  overrideContent?: React.ReactNode
  /** Shown inside the list when `models` is empty and there's no override. */
  emptyState?: React.ReactNode
  /** Rendered at the top of the list, always (e.g. a "use default" row). */
  leadingItems?: React.ReactNode
  /** Rendered below the list, after a separator (e.g. a remove action). */
  footer?: React.ReactNode
  searchPlaceholder?: string
  noMatchLabel?: string
  className?: string
  listClassName?: string
}

/**
 * The opencode-style two-level (provider → model) command-palette picker shared
 * by the chat prompt-input agent dock and the cron job dialog. Presentational
 * only: owns search + grouping + scroll-to-selection; the caller owns the
 * trigger/popover, the data source, and what selecting a row does.
 */
export function ModelPickerCommand({
  models,
  selectedId,
  onSelect,
  isSelected,
  overrideContent,
  emptyState,
  leadingItems,
  footer,
  searchPlaceholder,
  noMatchLabel,
  className,
  listClassName,
}: ModelPickerCommandProps) {
  const { t } = useTranslation()
  const [search, setSearch] = React.useState('')

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => {
      const label = (m.displayName || m.id).toLowerCase()
      return (
        label.includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.providerName ?? '').toLowerCase().includes(q)
      )
    })
  }, [models, search])

  const groups = React.useMemo(() => groupAgentModelOptions(filtered), [filtered])

  // On mount (PopoverContent mounts when opened), land the selected row in view
  // — the list can be long and starting at the top loses the user's place.
  // Re-armed until it fires, and skipped while the user is filtering.
  const listRef = React.useRef<HTMLDivElement>(null)
  const scrolledRef = React.useRef(false)
  React.useEffect(() => {
    if (scrolledRef.current || search) return
    const raf = requestAnimationFrame(() => {
      const el = listRef.current?.querySelector('[data-model-selected="true"]')
      if (el) {
        el.scrollIntoView({ block: 'center' })
        scrolledRef.current = true
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [search, filtered])

  const selectedTest = React.useCallback(
    (id: string) => (isSelected ? isSelected(id) : id === selectedId),
    [isSelected, selectedId],
  )

  return (
    <Command shouldFilter={false} className={className}>
      {models.length > 0 ? (
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={
            searchPlaceholder ??
            t('chat.agentSelector.searchModelPlaceholder', 'Search models…')
          }
          className="text-xs"
        />
      ) : null}
      <CommandList ref={listRef} className={cn('max-h-[18rem]', listClassName)}>
        {leadingItems ? <>{leadingItems}</> : null}
        {overrideContent ? (
          <>{overrideContent}</>
        ) : models.length === 0 ? (
          <>{emptyState}</>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {noMatchLabel ??
              t('chat.agentSelector.noMatchingModels', 'No matching models')}
          </div>
        ) : (
          groups.map((group) => (
            <CommandGroup key={group.providerName} heading={group.providerName}>
              {group.models.map((m) => {
                const label = m.displayName || m.id
                const selected = selectedTest(m.id)
                return (
                  <CommandItem
                    key={m.id}
                    value={`${label} ${m.id}`}
                    data-model-selected={selected ? 'true' : undefined}
                    onSelect={() => onSelect(m.id)}
                    className="text-xs py-1.5"
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 mr-1.5 shrink-0',
                        selected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="truncate">{label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))
        )}
      </CommandList>
      {footer ? (
        <>
          <CommandSeparator />
          {footer}
        </>
      ) : null}
    </Command>
  )
}
