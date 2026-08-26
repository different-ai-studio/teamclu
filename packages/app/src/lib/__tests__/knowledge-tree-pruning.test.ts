import { describe, expect, it } from 'vitest'

import { pruneKnowledgeNoise } from '../knowledge-tree-pruning'
import type { FileNode } from '@/stores/workspace'

const KNOWLEDGE = '/home/u/.amuxd/teams/t1/shared/knowledge'
const opts = { knowledgeDir: KNOWLEDGE, workspacePath: '/work' }

function dir(path: string, children: FileNode[] = []): FileNode {
  return { name: path.split('/').pop()!, path, type: 'directory', children }
}
function file(path: string): FileNode {
  return { name: path.split('/').pop()!, path, type: 'file' }
}

describe('pruneKnowledgeNoise', () => {
  it('hides .obsidian inside the knowledge tree', () => {
    const tree = [dir(`${KNOWLEDGE}/.obsidian`), file(`${KNOWLEDGE}/note.md`)]
    const out = pruneKnowledgeNoise(tree, opts)
    expect(out.map((n) => n.name)).toEqual(['note.md'])
  })

  it('hides a nested .obsidian too', () => {
    const tree = [
      dir(`${KNOWLEDGE}/sub`, [dir(`${KNOWLEDGE}/sub/.obsidian`), file(`${KNOWLEDGE}/sub/a.md`)]),
    ]
    const out = pruneKnowledgeNoise(tree, opts)
    expect(out[0].children!.map((n) => n.name)).toEqual(['a.md'])
  })

  it('hides conflict sidecars but keeps the document itself', () => {
    const tree = [
      file(`${KNOWLEDGE}/note.md`),
      file(`${KNOWLEDGE}/note.conflict.1748332800.abc123de.md`),
    ]
    const out = pruneKnowledgeNoise(tree, opts)
    expect(out.map((n) => n.name)).toEqual(['note.md'])
  })

  // The scoping test. A user's own vault, or a source file that happens to be
  // called `foo.conflict.ts`, lives outside the knowledge tree and must be left
  // alone — hiding it would be a bug of our own.
  it('leaves .obsidian alone outside the knowledge tree', () => {
    const tree = [dir('/work/my-vault/.obsidian'), file('/work/a.md')]
    const out = pruneKnowledgeNoise(tree, opts)
    expect(out.map((n) => n.name)).toEqual(['.obsidian', 'a.md'])
  })

  // Returning the same reference is what keeps the common case from
  // re-rendering the whole tree on every store update.
  it('returns the same array when nothing is pruned', () => {
    const tree = [file(`${KNOWLEDGE}/note.md`)]
    expect(pruneKnowledgeNoise(tree, opts)).toBe(tree)
  })

  // A file named `.obsidian` is not the config directory.
  it('only prunes .obsidian when it is a directory', () => {
    const tree = [file(`${KNOWLEDGE}/.obsidian`)]
    expect(pruneKnowledgeNoise(tree, opts).map((n) => n.name)).toEqual(['.obsidian'])
  })
})
