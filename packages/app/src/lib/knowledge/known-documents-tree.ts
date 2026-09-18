import type { FileNode } from '@/stores/workspace'
import { joinPathLike } from '@/lib/fs-path'

/**
 * The tree with every listed-but-unfetched document drawn in.
 *
 * `documents/` is fetched on demand: the daemon records what the manifest
 * carries (`/v1/team/documents/known`) and writes nothing to disk for it. A
 * tree built from the disk scan alone therefore never shows a teammate's
 * upload, and two members looking at 资料库 see two unrelated trees. The rows
 * have to come from the manifest UNION the disk, and this is that union.
 */
export interface KnownDocumentsMerge {
  nodes: FileNode[]
  /**
   * Paths of rows that exist only because the manifest lists them — files not
   * downloaded, and folders with nothing downloaded beneath them. Nothing is on
   * disk at any of these, so nothing that reads the disk can act on them.
   */
  placeholderPaths: Set<string>
}

type EntryKind = FileNode['type']

const DOCUMENTS_ROOT = 'documents'

/**
 * Stand-in child name used to find the sync key of a link root; see `directoryKey`.
 * Starts with NUL, which no real path segment can contain. Written as an escape
 * so the source stays text — a literal NUL makes git treat the file as binary.
 */
const PROBE = '\u0000probe'

/**
 * Merge listed documents into `nodes`.
 *
 * Only folders whose listing has already been read are filled. An on-disk
 * folder with `children` undefined is left alone: a partial child list would
 * read as "loaded", and its real contents would never be fetched. It is filled
 * on the render after it is expanded.
 *
 * Returns the SAME array when nothing was added, so the common case — nothing
 * listed, or everything listed already downloaded — costs one walk and no
 * downstream re-render.
 */
export function mergeKnownDocuments(
  nodes: FileNode[],
  knownKeys: Iterable<string>,
  keyForPath: (absPath: string) => string | null,
): KnownDocumentsMerge {
  const placeholderPaths = new Set<string>()
  const index = indexByParent(knownKeys)
  if (index.size === 0) return { nodes, placeholderPaths }

  const placeholder = (path: string, key: string, name: string, kind: EntryKind): FileNode => {
    placeholderPaths.add(path)
    if (kind === 'file') return { name, path, type: 'file' }
    const children = [...(index.get(key) ?? [])].map(([child, childKind]) =>
      // Joined the way the parent is spelled: a placeholder row is compared
      // against on-disk nodes and against `expandedPaths`, both of which use
      // the platform separator on Windows.
      placeholder(joinPathLike(path, child), `${key}/${child}`, child, childKind),
    )
    return { name, path, type: 'directory', children: sortEntries(children) }
  }

  const walk = (level: FileNode[]): FileNode[] => {
    let changed = false
    const out = level.map((node) => {
      if (node.type !== 'directory' || !node.children) return node
      const key = directoryKey(node.path, keyForPath)
      // Some other synced root (knowledge/): nothing listed can live below it.
      if (key !== null && key !== DOCUMENTS_ROOT && !key.startsWith(`${DOCUMENTS_ROOT}/`)) {
        return node
      }

      const children = walk(node.children)
      const listed = key === null ? undefined : index.get(key)
      const present = new Set(children.map((c) => c.name))
      const added: FileNode[] = []
      for (const [name, kind] of listed ?? []) {
        if (present.has(name)) continue
        added.push(placeholder(joinPathLike(node.path, name), `${key}/${name}`, name, kind))
      }

      if (added.length === 0 && children === node.children) return node
      changed = true
      return {
        ...node,
        children: added.length > 0 ? sortEntries([...children, ...added]) : children,
      }
    })
    return changed ? out : level
  }

  return { nodes: walk(nodes), placeholderPaths }
}

/** Sync key of a folder → the names listed directly inside it. */
function indexByParent(knownKeys: Iterable<string>): Map<string, Map<string, EntryKind>> {
  const index = new Map<string, Map<string, EntryKind>>()
  for (const key of knownKeys) {
    const segments = key.split('/')
    if (segments[0] !== DOCUMENTS_ROOT || segments.length < 2 || segments.some((s) => s === '')) {
      continue
    }
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/')
      const kind: EntryKind = i === segments.length - 1 ? 'file' : 'directory'
      let entries = index.get(parent)
      if (!entries) {
        entries = new Map()
        index.set(parent, entries)
      }
      // A folder is never demoted to a file by a later key.
      if (entries.get(segments[i]) !== 'directory') entries.set(segments[i], kind)
    }
  }
  return index
}

/**
 * Sync key of a folder, including a root reached through a workspace link.
 *
 * `team-documents` in a workspace IS the documents root, yet its own path maps
 * to no key — only paths inside it do. Asking about a child and dropping the
 * child's name answers for the link without a second copy of the link table.
 */
function directoryKey(path: string, keyForPath: (absPath: string) => string | null): string | null {
  const own = keyForPath(path)
  if (own !== null) return own
  const inside = keyForPath(`${path}/${PROBE}`)
  return inside?.endsWith(`/${PROBE}`) ? inside.slice(0, -(PROBE.length + 1)) : null
}

/**
 * Folders first, then by name — the order `sortWorkspaceEntries` gives a
 * listing below the workspace root. Not imported from the store: this module
 * stays pure, and the store is mocked wholesale in the tree's tests.
 */
function sortEntries(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
