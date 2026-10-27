/**
 * Which agent the Skills column manages when the user opens it.
 *
 * The column used to auto-select only when exactly one agent was manageable,
 * so a team with several agents landed on "选择 Agent" and an empty list.
 * Opening Skills prefers the agent the user is with right now.
 */

export function isSkillsMarketplaceDetail(detail: { kind: string } | null | undefined): boolean {
  return detail?.kind === 'marketplace' || detail?.kind === 'marketplace-item'
}

/** A skill or marketplace view already occupies the main column. */
export function skillsDetailOccupiesPane(detail: { kind: string } | null | undefined): boolean {
  return (
    detail?.kind === 'skill' ||
    detail?.kind === 'skill-file' ||
    isSkillsMarketplaceDetail(detail)
  )
}

/**
 * Pick the agent id to manage, or null when the previous selection is stale
 * and nothing else qualifies.
 *
 * `preferCurrent` is the Skills entry: the agent in the current conversation
 * (then this machine's daemon) wins over whoever was selected last time.
 * Later refreshes pass false so a manual pick sticks, and still fill an empty
 * selection from `preferredIds`.
 */
export function pickDefaultSubjectActor(input: {
  agents: readonly { id: string }[]
  selectedId: string | null
  preferredIds: readonly (string | null | undefined)[]
  preferCurrent: boolean
}): string | null {
  const ids = new Set(input.agents.map((agent) => agent.id))
  const preferred = input.preferredIds.find((id): id is string => !!id && ids.has(id)) ?? null
  const selected = input.selectedId && ids.has(input.selectedId) ? input.selectedId : null
  if (input.preferCurrent && preferred) return preferred
  if (selected) return selected
  if (preferred) return preferred
  if (input.agents.length === 1) return input.agents[0].id
  return null
}
