import { describe, expect, it } from 'vitest'
import { teamPackOnDisk } from '../team-share-browser'

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
