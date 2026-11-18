import { useTranslation } from 'react-i18next'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { navGroupMemberOf, navGroupMembers, type NavGroupMemberId } from '@/lib/layout/nav-groups'
import { useSelectNavGroupMember } from '@/components/sidebar/NavGroupEntries'

const MEMBER_LABELS: Record<NavGroupMemberId, { key: string; fallback: string }> = {
  knowledge: { key: 'teamShare.knowledge', fallback: 'Knowledge' },
  ideas: { key: 'sidebar.ideas', fallback: 'Ideas' },
  skills: { key: 'teamShare.skills', fallback: 'Skills' },
  mcp: { key: 'teamShare.mcp', fallback: 'MCP' },
  env: { key: 'teamShare.env', fallback: 'Team Env' },
}

/**
 * Switch across the members of a grouped rail entry (知识, 能力), at the top of
 * column two. Renders nothing outside a group, or for a group this build
 * shows only one member of.
 */
export function NavGroupSwitch() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const embedMode = useUIStore((s) => s.embedMode)
  const select = useSelectNavGroupMember()
  const current = navGroupMemberOf(filter)
  if (!current) return null
  const members = navGroupMembers(current.group, { embedMode })
  if (members.length < 2) return null

  return (
    <div
      className="flex shrink-0 items-center border-b border-border-soft bg-background px-3 py-2"
      data-tauri-drag-region
    >
      <div
        role="tablist"
        aria-orientation="horizontal"
        data-testid="nav-group-switch"
        className="flex w-full gap-0.5 rounded-[10px] bg-black/[0.04] p-0.5"
      >
        {members.map((m) => {
          const active = m.id === current.member
          const label = t(MEMBER_LABELS[m.id].key, MEMBER_LABELS[m.id].fallback)
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => (active ? undefined : select(m.filter))}
              className={cn(
                'min-w-0 flex-1 truncate rounded-[8px] px-2 py-1.5 text-[13px] transition-[background-color,box-shadow,color] duration-150',
                active
                  ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.06)]'
                  : 'text-ink-2 hover:text-foreground',
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
