import { describe, expect, it } from 'vitest'
import { isHostedTeamSkillsDir, teamPackOnDisk } from '../team-share-browser'

describe('teamPackOnDisk', () => {
  it('is true when the local scan found a team pack', () => {
    const onDisk = new Map([
      [
        'seatalk-webhook',
        {
          content: '# skill',
          dirPath: '/Users/me/.agents/skills',
          invocationName: 'seatalk-webhook',
          source: 'global-agent' as const,
        },
      ],
    ])
    expect(teamPackOnDisk('seatalk-webhook', onDisk)).toBe(true)
  })

  it('is false when sync health is drift but nothing is on disk yet', () => {
    expect(teamPackOnDisk('seatalk-webhook', new Map())).toBe(false)
  })
})

describe('isHostedTeamSkillsDir', () => {
  it('matches the daemon cloud cache root', () => {
    expect(
      isHostedTeamSkillsDir(
        '/Users/me/.amuxd-teamclaw/teams/30b7006d-4225-4160-8c12-0a057268a914/state/cloud/skills',
      ),
    ).toBe(true)
  })

  it('rejects the working copy and lookalike company paths', () => {
    expect(isHostedTeamSkillsDir('/Users/me/.agents/skills')).toBe(false)
    expect(isHostedTeamSkillsDir('/opt/company/teams/team-a/state/cloud/skills')).toBe(false)
    expect(isHostedTeamSkillsDir('/Users/me/.amuxd/teams/team-a/shared/skills')).toBe(false)
  })
})
