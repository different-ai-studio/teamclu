import { describe, test, expect } from 'vitest'
import {
  encodeTeamShareTarget,
  decodeTeamShareTarget,
  encodeVersionHistoryTarget,
  decodeVersionHistoryTarget,
  isTeamShareOwnedTarget,
  tabSelectionForSection,
  type TeamShareTabTarget,
} from '@/lib/tabs/teamshare-target'

const round = (t: TeamShareTabTarget) => decodeTeamShareTarget(encodeTeamShareTarget(t))

describe('team-share tab targets', () => {
  test('round-trip every view', () => {
    const cases: TeamShareTabTarget[] = [
      { kind: 'skill', id: 'deploy-check' },
      // A personal skill colliding with a registry name is addressed this way.
      { kind: 'skill', id: 'personal:deploy-check' },
      { kind: 'skill-file', id: 'deploy-check', rel: 'SKILL.md' },
      // The part that makes naive splitting wrong.
      { kind: 'skill-file', id: 'personal:deploy-check', rel: 'scripts/nested/run.sh' },
      { kind: 'mcp', name: 'context7' },
      { kind: 'env', keyId: 'team:OPENAI_API_KEY' },
      { kind: 'create', section: 'mcp' },
      { kind: 'create', section: 'env' },
    ]
    for (const c of cases) expect(round(c)).toEqual(c)
  })

  test('rejects anything that is not ours', () => {
    expect(decodeTeamShareTarget('/Users/me/notes.md')).toBeNull()
    expect(decodeTeamShareTarget('https://example.com')).toBeNull()
    expect(decodeTeamShareTarget('teamshare:')).toBeNull()
    expect(decodeTeamShareTarget('teamshare:skill/')).toBeNull()
    expect(decodeTeamShareTarget('teamshare:unknown/x')).toBeNull()
    // A skill file needs both halves; the skill alone is a different view.
    expect(decodeTeamShareTarget('teamshare:skill-file/deploy-check')).toBeNull()
    expect(decodeTeamShareTarget('teamshare:create/skills')).toBeNull()
  })

  test('version history carries the file path, and the bare target means "all"', () => {
    const target = encodeVersionHistoryTarget('/team/knowledge/spec.md')
    expect(decodeVersionHistoryTarget(target)).toBe('/team/knowledge/spec.md')
    expect(decodeVersionHistoryTarget('version-history')).toBeNull()
    // undefined, not null: "not a version history target" is a third answer.
    expect(decodeVersionHistoryTarget('teamshare:skill/x')).toBeUndefined()
  })

  test('bulk close covers both prefixes and nothing else', () => {
    expect(isTeamShareOwnedTarget('teamshare:skill/deploy-check')).toBe(true)
    expect(isTeamShareOwnedTarget('version-history/x.md')).toBe(true)
    expect(isTeamShareOwnedTarget('version-history')).toBe(true)
    expect(isTeamShareOwnedTarget('/Users/me/notes.md')).toBe(false)
  })

  test('a file inside a package keeps its skill row selected', () => {
    // Otherwise opening a script would un-highlight the folder it lives in.
    expect(tabSelectionForSection('teamshare:skill-file/deploy-check/scripts/run.sh', 'skills')).toBe(
      'deploy-check',
    )
    expect(tabSelectionForSection('teamshare:skill/deploy-check', 'skills')).toBe('deploy-check')
    expect(tabSelectionForSection('teamshare:mcp/context7', 'mcp')).toBe('context7')
    expect(tabSelectionForSection('teamshare:env/team:KEY', 'env')).toBe('team:KEY')
  })

  test('a tab from one section never highlights another', () => {
    expect(tabSelectionForSection('teamshare:mcp/context7', 'skills')).toBeNull()
    expect(tabSelectionForSection('teamshare:skill/deploy-check', 'env')).toBeNull()
    expect(tabSelectionForSection('/Users/me/notes.md', 'skills')).toBeNull()
    // Knowledge documents are plain file tabs; no row to highlight.
    expect(tabSelectionForSection('teamshare:skill/x', 'knowledge')).toBeNull()
  })
})
