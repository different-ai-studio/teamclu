import type { SidebarFilter } from '@/stores/ui'

/**
 * First-column destinations that share one rail entry.
 *
 * The rail shows one tile per group, and column two shows a switch across the
 * group's members at its top. That keeps the rail short enough to read at a
 * glance — every tile carries a label, so fewer tiles is the whole point —
 * without dropping any destination.
 *
 * - `knowledge` — what the team knows: the knowledge base and ideas.
 * - `abilities` — what the team's agents can do: skills, MCP servers, and the
 *   secrets they run with.
 */
export type NavGroupId = 'knowledge' | 'abilities'

export type NavGroupMemberId = 'knowledge' | 'ideas' | 'skills' | 'mcp' | 'env'

export interface NavGroupMember {
  id: NavGroupMemberId
  filter: SidebarFilter
}

const MEMBERS: Record<NavGroupId, NavGroupMember[]> = {
  knowledge: [
    { id: 'knowledge', filter: { kind: 'teamShare', section: 'knowledge' } },
    { id: 'ideas', filter: { kind: 'ideas' } },
  ],
  abilities: [
    { id: 'skills', filter: { kind: 'teamShare', section: 'skills' } },
    { id: 'mcp', filter: { kind: 'teamShare', section: 'mcp' } },
    { id: 'env', filter: { kind: 'teamShare', section: 'env' } },
  ],
}

/** The group's members, minus the ones this build does not show. Ideas live
 * outside the embedded (extension) build, like the rest of its column. */
export function navGroupMembers(group: NavGroupId, opts: { embedMode: boolean }): NavGroupMember[] {
  return MEMBERS[group].filter((m) => !(opts.embedMode && m.id === 'ideas'))
}

/** Which member a filter selects, if it selects one. */
export function navGroupMemberOf(filter: SidebarFilter): { group: NavGroupId; member: NavGroupMemberId } | null {
  if (filter.kind === 'ideas') return { group: 'knowledge', member: 'ideas' }
  if (filter.kind !== 'teamShare') return null
  if (filter.section === 'knowledge') return { group: 'knowledge', member: 'knowledge' }
  return { group: 'abilities', member: filter.section }
}

/** Where a group's rail tile goes: back to the member last open in it, else
 * its first. */
export function navGroupEntryFilter(
  group: NavGroupId,
  last: NavGroupMemberId | undefined,
  opts: { embedMode: boolean },
): SidebarFilter {
  const members = navGroupMembers(group, opts)
  return (members.find((m) => m.id === last) ?? members[0]).filter
}
