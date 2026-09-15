/**
 * Returns the set of actor ids to pre-select when the New Session dialog opens.
 *
 * Includes the team's effective default agent when it is a selectable
 * candidate, and always includes the agent running on this machine — the two
 * are often different rows that share a display name, and the workspace
 * picker only applies to the local one.
 */
export function computeInitialSelection(
  effectiveDefaultAgentId: string | null,
  candidateIds: ReadonlySet<string>,
  localAgentId?: string | null,
): Set<string> {
  const next = new Set<string>()
  if (effectiveDefaultAgentId && candidateIds.has(effectiveDefaultAgentId)) {
    next.add(effectiveDefaultAgentId)
  }
  const local = localAgentId?.trim() || ''
  if (local && candidateIds.has(local)) next.add(local)
  return next
}
