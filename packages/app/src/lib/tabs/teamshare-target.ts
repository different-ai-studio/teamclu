/**
 * Addresses for team-share detail views. New selections keep the structured
 * object directly in the browser store; string encoding remains for tabs saved
 * by older builds and for backward-compatible native-content rendering.
 */

export type TeamShareTarget =
  | { kind: 'skill'; id: string }
  /** One file inside a skill package. `rel` is package-relative, `/`-separated. */
  | { kind: 'skill-file'; id: string; rel: string }
  | { kind: 'mcp'; name: string }
  | { kind: 'env'; keyId: string }
  /** The compose surface for a new MCP server or env key. */
  | { kind: 'create'; section: 'mcp' | 'env' }
  /** First-party skills marketplace browse view (design §10.2). */
  | { kind: 'marketplace' }
  /** One marketplace catalog item's detail view. */
  | { kind: 'marketplace-item'; slug: string }

/** @deprecated Team-share items now render in a single direct detail pane. */
export type TeamShareTabTarget = TeamShareTarget

const PREFIX = 'teamshare:'

/** Version history is not team-share-specific, so it keeps its own prefix. */
const VERSION_HISTORY = 'version-history'

/** The conflict-decision view for one team document. */
const KNOWLEDGE_CONFLICT = 'knowledge-conflict'

/** The read-only "what does the cloud hold" view for one team document. */
const CLOUD_VERSION = 'knowledge-cloud'

export function encodeTeamShareTarget(t: TeamShareTarget): string {
  switch (t.kind) {
    case 'skill':
      return `${PREFIX}skill/${t.id}`
    case 'skill-file':
      return `${PREFIX}skill-file/${t.id}/${t.rel}`
    case 'mcp':
      return `${PREFIX}mcp/${t.name}`
    case 'env':
      return `${PREFIX}env/${t.keyId}`
    case 'create':
      return `${PREFIX}create/${t.section}`
    // No id to carry, but the decoder requires a non-empty body after the
    // kind — a placeholder segment, never inspected on decode.
    case 'marketplace':
      return `${PREFIX}marketplace/_`
    case 'marketplace-item':
      return `${PREFIX}marketplace-item/${t.slug}`
  }
}

/**
 * Parse a tab target back into a view, or null when it is not one of ours.
 *
 * Only the *first* separator after the kind is significant: ids never contain
 * `/` (a slug, or `personal:<slug>`), while the rest — a package-relative file
 * path — routinely does.
 */
export function decodeTeamShareTarget(target: string): TeamShareTarget | null {
  if (!target.startsWith(PREFIX)) return null
  const body = target.slice(PREFIX.length)
  const slash = body.indexOf('/')
  if (slash <= 0) return null
  const kind = body.slice(0, slash)
  const rest = body.slice(slash + 1)
  if (!rest) return null

  switch (kind) {
    case 'skill':
      return { kind: 'skill', id: rest }
    case 'skill-file': {
      const cut = rest.indexOf('/')
      if (cut <= 0) return null
      const rel = rest.slice(cut + 1)
      if (!rel) return null
      return { kind: 'skill-file', id: rest.slice(0, cut), rel }
    }
    case 'mcp':
      return { kind: 'mcp', name: rest }
    case 'env':
      return { kind: 'env', keyId: rest }
    case 'create':
      return rest === 'mcp' || rest === 'env' ? { kind: 'create', section: rest } : null
    case 'marketplace':
      return { kind: 'marketplace' }
    case 'marketplace-item':
      return { kind: 'marketplace-item', slug: rest }
    default:
      return null
  }
}

export function encodeVersionHistoryTarget(path: string): string {
  return `${VERSION_HISTORY}/${path}`
}

/**
 * The file whose history a target names, `null` for the browse-everything view
 * (the bare `version-history` target) and `undefined` when it is not a version
 * history target at all.
 */
export function decodeVersionHistoryTarget(target: string): string | null | undefined {
  if (target === VERSION_HISTORY) return null
  if (!target.startsWith(`${VERSION_HISTORY}/`)) return undefined
  return target.slice(VERSION_HISTORY.length + 1) || null
}

export function encodeKnowledgeConflictTarget(path: string): string {
  return `${KNOWLEDGE_CONFLICT}/${path}`
}

/**
 * The document whose conflict a target names, `undefined` when it is not a
 * conflict target. Unlike version history there is no browse-all form: a
 * decision is always about one document.
 */
export function decodeKnowledgeConflictTarget(target: string): string | undefined {
  if (!target.startsWith(`${KNOWLEDGE_CONFLICT}/`)) return undefined
  return target.slice(KNOWLEDGE_CONFLICT.length + 1) || undefined
}

export function encodeCloudVersionTarget(path: string): string {
  return `${CLOUD_VERSION}/${path}`
}

/** The document whose cloud copy a target names, `undefined` when it is not one. */
export function decodeCloudVersionTarget(target: string): string | undefined {
  if (!target.startsWith(`${CLOUD_VERSION}/`)) return undefined
  return target.slice(CLOUD_VERSION.length + 1) || undefined
}

/** Every target this module owns, for bulk close when the team changes. */
export function isTeamShareOwnedTarget(target: string): boolean {
  return (
    target.startsWith(PREFIX) ||
    decodeVersionHistoryTarget(target) !== undefined ||
    // A conflict belongs to the team whose tree it is in; keeping the tab open
    // across a team switch would offer a decision about another team's file.
    decodeKnowledgeConflictTarget(target) !== undefined ||
    decodeCloudVersionTarget(target) !== undefined
  )
}

/**
 * Which team-share row a tab highlights, if any.
 *
 * A file inside a package still belongs to its skill: the list column keeps the
 * skill row marked while one of its files is open, which is what makes the
 * folder read as "this is where you are".
 */
export function tabSelectionForSection(
  target: string,
  section: 'skills' | 'mcp' | 'env' | 'knowledge',
): string | null {
  const t = decodeTeamShareTarget(target)
  if (!t) return null
  if (section === 'skills') {
    if (t.kind === 'skill') return t.id
    if (t.kind === 'skill-file') return t.id
    return null
  }
  if (section === 'mcp') return t.kind === 'mcp' ? t.name : null
  if (section === 'env') return t.kind === 'env' ? t.keyId : null
  return null
}

/** Which sidebar section owns a direct team-share detail target. */
export function teamShareSectionForTarget(
  target: TeamShareTarget | null,
): 'skills' | 'mcp' | 'env' | null {
  if (!target) return null
  if (target.kind === 'skill' || target.kind === 'skill-file') return 'skills'
  if (target.kind === 'mcp') return 'mcp'
  if (target.kind === 'env') return 'env'
  // The marketplace lives under the Skills nav row — it is a second way into
  // the same registry, not a section of its own.
  if (target.kind === 'marketplace' || target.kind === 'marketplace-item') return 'skills'
  return target.section
}

/** Which row a direct detail target highlights in the requested section. */
export function detailSelectionForSection(
  target: TeamShareTarget | null,
  section: 'skills' | 'mcp' | 'env' | 'knowledge',
): string | null {
  if (!target || teamShareSectionForTarget(target) !== section) return null
  if (target.kind === 'skill' || target.kind === 'skill-file') return target.id
  if (target.kind === 'mcp') return target.name
  if (target.kind === 'env') return target.keyId
  return null
}
