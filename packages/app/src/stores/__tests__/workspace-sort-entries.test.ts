/**
 * Entry order in a workspace directory.
 *
 * The team's links are the team's content, not the project's, so at the root
 * they sit above it. `teamclu-team` used to be pinned there at every level; the
 * daemon no longer creates it, and it is no longer special.
 */
import { describe, it, expect } from 'vitest'
import { sortWorkspaceEntries, type FileNode } from '@/stores/workspace'

const dir = (name: string): FileNode => ({ name, path: `/ws/${name}`, type: 'directory' })
const file = (name: string): FileNode => ({ name, path: `/ws/${name}`, type: 'file' })
const names = (nodes: FileNode[]) => nodes.map((n) => n.name)

describe('sortWorkspaceEntries', () => {
  it('pins team-documents then team-knowledge to the top of the root', () => {
    const out = sortWorkspaceEntries(
      [file('README.md'), dir('claude'), dir('team-knowledge'), dir('apps'), dir('team-documents')],
      true,
    )
    expect(names(out)).toEqual(['team-documents', 'team-knowledge', 'apps', 'claude', 'README.md'])
  })

  it('pins nothing below the root', () => {
    const out = sortWorkspaceEntries([dir('zeta'), dir('team-knowledge'), dir('alpha')], false)
    expect(names(out)).toEqual(['alpha', 'team-knowledge', 'zeta'])
  })

  it('does not pin a file that happens to share a link name', () => {
    const out = sortWorkspaceEntries([dir('b'), file('team-documents')], true)
    expect(names(out)).toEqual(['b', 'team-documents'])
  })

  it('no longer pins teamclu-team', () => {
    const out = sortWorkspaceEntries([dir('claude'), dir('teamclu-team'), dir('apps')], true)
    expect(names(out)).toEqual(['apps', 'claude', 'teamclu-team'])
  })

  it('does not mutate its input', () => {
    const input = [dir('b'), dir('team-knowledge'), dir('a')]
    sortWorkspaceEntries(input, true)
    expect(names(input)).toEqual(['b', 'team-knowledge', 'a'])
  })
})
