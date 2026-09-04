import { describe, expect, it } from 'vitest'
import { shortenWorkspacePath, workspaceNameFromPath } from '../shorten-path'

describe('shortenWorkspacePath', () => {
  it('leaves a path that already fits alone', () => {
    expect(shortenWorkspacePath('/tmp/teamclu')).toBe('/tmp/teamclu')
  })

  it('drops leading segments, keeping the tail that identifies the folder', () => {
    const a = shortenWorkspacePath('/Volumes/openbeta/workspace/teamclaw-worktrees/app-website')
    const b = shortenWorkspacePath('/Volumes/openbeta/workspace/teamclaw-worktrees/app-project')
    expect(a.startsWith('…/')).toBe(true)
    expect(a.endsWith('app-website')).toBe(true)
    // The whole point: siblings must not collapse to the same string, which is
    // what end-truncation does to them.
    expect(a).not.toBe(b)
  })

  it('never cuts into the last segment, however long it is', () => {
    const basename = 'a'.repeat(80)
    expect(shortenWorkspacePath(`/Users/x/${basename}`)).toContain(basename)
  })

  it('honours the length budget', () => {
    const out = shortenWorkspacePath('/one/two/three/four/five/six/seven/eight', 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.endsWith('eight')).toBe(true)
  })

  // Splitting on '/' alone left Windows paths untouched, so they fell back to
  // the CSS end-truncation this helper exists to replace.
  it('shortens Windows paths and keeps their separator', () => {
    const full = 'C:\\Users\\me\\workspace\\teamclaw-worktrees\\app-website'
    const out = shortenWorkspacePath(full)

    expect(out).not.toBe(full)
    expect(out.startsWith('…\\')).toBe(true)
    expect(out).not.toContain('/')
    expect(out.endsWith('\\app-website')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(42)
  })
})

describe('workspaceNameFromPath', () => {
  it('takes the last segment on either separator', () => {
    expect(workspaceNameFromPath('/tmp/teamclu')).toBe('teamclu')
    expect(workspaceNameFromPath('C:\\Users\\me\\teamclu')).toBe('teamclu')
  })

  it('ignores a trailing separator', () => {
    expect(workspaceNameFromPath('/tmp/teamclu/')).toBe('teamclu')
  })
})
