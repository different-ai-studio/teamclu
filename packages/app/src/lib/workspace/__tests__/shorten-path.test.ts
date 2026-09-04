import { describe, expect, it } from 'vitest'
import { shortenWorkspacePath } from '../shorten-path'

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
})
