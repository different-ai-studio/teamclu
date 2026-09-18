import { describe, expect, it } from 'vitest'

import { mergeKnownDocuments } from '@/lib/knowledge/known-documents-tree'
import { teamSyncKeyForPath } from '@/lib/team/team-skill-paths'
import type { FileNode } from '@/stores/workspace'

const SYNC_ROOT = '/home/u/.amuxd/teams/t1/shared/team-sync'
const DOCS = `${SYNC_ROOT}/documents`
const KNOWLEDGE = `${SYNC_ROOT}/knowledge`
const WORKSPACE = '/work'

const keyForPath = (p: string) =>
  teamSyncKeyForPath(p, { syncRoot: SYNC_ROOT, workspacePath: WORKSPACE })

function dir(path: string, children?: FileNode[]): FileNode {
  return { name: path.split('/').pop()!, path, type: 'directory', children }
}
function file(path: string): FileNode {
  return { name: path.split('/').pop()!, path, type: 'file' }
}
function names(nodes: FileNode[] | undefined): string[] {
  return (nodes ?? []).map((n) => n.name)
}

describe('mergeKnownDocuments', () => {
  // The reported case: one member's documents root held only a folder of their
  // own, and everything a teammate uploaded was listed but invisible.
  it('draws a listed file and a listed folder chain that are not on disk', () => {
    const tree = [dir(DOCS, [dir(`${DOCS}/运营部`)]), dir(KNOWLEDGE, [])]
    const { nodes, placeholderPaths } = mergeKnownDocuments(
      tree,
      ['documents/untitled.md', 'documents/运营标准和SOP汇总/1. 门店运营/手册.md'],
      keyForPath,
    )

    const docs = nodes[0]
    expect(names(docs.children)).toEqual(['运营标准和SOP汇总', '运营部', 'untitled.md'])
    const sop = docs.children![0]
    expect(sop).toMatchObject({ type: 'directory', path: `${DOCS}/运营标准和SOP汇总` })
    expect(names(sop.children)).toEqual(['1. 门店运营'])
    expect(names(sop.children![0].children)).toEqual(['手册.md'])

    expect([...placeholderPaths].sort()).toEqual(
      [
        `${DOCS}/untitled.md`,
        `${DOCS}/运营标准和SOP汇总`,
        `${DOCS}/运营标准和SOP汇总/1. 门店运营`,
        `${DOCS}/运营标准和SOP汇总/1. 门店运营/手册.md`,
      ].sort(),
    )
  })

  // A folder that exists on disk but also holds unfetched files: the disk rows
  // stay, the listed ones join them, and the folder itself is not a placeholder.
  it('adds listed files beside the ones already downloaded in a real folder', () => {
    const tree = [dir(DOCS, [dir(`${DOCS}/hr`, [file(`${DOCS}/hr/have.md`)])])]
    const { nodes, placeholderPaths } = mergeKnownDocuments(
      tree,
      ['documents/hr/missing.pdf'],
      keyForPath,
    )
    expect(names(nodes[0].children![0].children)).toEqual(['have.md', 'missing.pdf'])
    expect(placeholderPaths.has(`${DOCS}/hr`)).toBe(false)
    expect(placeholderPaths.has(`${DOCS}/hr/missing.pdf`)).toBe(true)
  })

  // Between a download landing and the listing being re-read, the same path is
  // both on disk and listed. One row, and it is the real one.
  it('never doubles a file that is already on disk', () => {
    const tree = [dir(DOCS, [file(`${DOCS}/a.md`)])]
    const { nodes, placeholderPaths } = mergeKnownDocuments(tree, ['documents/a.md'], keyForPath)
    expect(names(nodes[0].children)).toEqual(['a.md'])
    expect(placeholderPaths.size).toBe(0)
  })

  // An on-disk folder whose listing has not been read yet stays unread: giving
  // it a partial child list would look loaded and hide what is really there.
  it('leaves a real folder that has not been listed yet alone', () => {
    const tree = [dir(DOCS, [dir(`${DOCS}/hr`)])]
    const { nodes } = mergeKnownDocuments(tree, ['documents/hr/a.pdf'], keyForPath)
    expect(nodes[0].children![0].children).toBeUndefined()
  })

  it('does not touch knowledge/', () => {
    const tree = [dir(KNOWLEDGE, [])]
    const { nodes } = mergeKnownDocuments(tree, ['knowledge/a.md'], keyForPath)
    expect(nodes[0].children).toEqual([])
  })

  it('returns the same tree when nothing is listed', () => {
    const tree = [dir(DOCS, [file(`${DOCS}/a.md`)])]
    expect(mergeKnownDocuments(tree, [], keyForPath).nodes).toBe(tree)
  })

  it('returns the same tree when everything listed is already there', () => {
    const tree = [dir(DOCS, [file(`${DOCS}/a.md`)])]
    expect(mergeKnownDocuments(tree, ['documents/a.md'], keyForPath).nodes).toBe(tree)
  })

  // The workspace tree reaches documents through the `team-documents` link,
  // whose own path maps to no sync key — only what is inside it does.
  it('fills the workspace team-documents link as well', () => {
    const link = `${WORKSPACE}/team-documents`
    const wsKey = (p: string) => teamSyncKeyForPath(p, { syncRoot: null, workspacePath: WORKSPACE })
    const tree = [dir(link, []), dir(`${WORKSPACE}/src`, [])]
    const { nodes } = mergeKnownDocuments(tree, ['documents/x/y.md'], wsKey)
    expect(names(nodes[0].children)).toEqual(['x'])
    expect(nodes[0].children![0].path).toBe(`${link}/x`)
    expect(nodes[1].children).toEqual([])
  })
})

/**
 * The same merge on Windows, where the root the app built and the paths Rust
 * returned are spelled differently. `keyForPath` used to return null for every
 * node here, so nothing was ever drawn in: on Windows 资料库 stayed empty no
 * matter how many documents the team had uploaded.
 */
describe('mergeKnownDocuments on Windows', () => {
  const BUILT_ROOT = 'C:\\Users\\x/.amuxd/teams/t1/shared/team-sync'
  const RUST_ROOT = 'C:\\Users\\x\\.amuxd\\teams\\t1\\shared\\team-sync'
  const RUST_DOCS = `${RUST_ROOT}\\documents`

  const winKey = (p: string) =>
    teamSyncKeyForPath(p, { syncRoot: BUILT_ROOT, workspacePath: 'C:\\work' })

  it('draws listed documents and spells their paths the way the disk does', () => {
    const tree: FileNode[] = [
      { name: 'documents', path: RUST_DOCS, type: 'directory', children: [] },
      { name: 'knowledge', path: `${RUST_ROOT}\\knowledge`, type: 'directory', children: [] },
    ]

    const { nodes, placeholderPaths } = mergeKnownDocuments(
      tree,
      ['documents/人力资源/offer.pdf'],
      winKey,
    )

    const docs = nodes[0]
    expect(names(docs.children)).toEqual(['人力资源'])
    const hr = docs.children![0]
    expect(hr.path).toBe(`${RUST_DOCS}\\人力资源`)
    expect(names(hr.children)).toEqual(['offer.pdf'])
    expect(placeholderPaths.has(`${RUST_DOCS}\\人力资源\\offer.pdf`)).toBe(true)
  })
})
