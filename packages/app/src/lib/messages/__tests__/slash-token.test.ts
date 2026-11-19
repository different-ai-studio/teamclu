import { describe, expect, it } from 'vitest'
import { parseSlashToken } from '../slash-token'

describe('parseSlashToken', () => {
  it('reads the typed prefixes', () => {
    expect(parseSlashToken('role:reviewer')).toEqual({ type: 'role', name: 'reviewer' })
    expect(parseSlashToken('skill:deploy-app')).toEqual({ type: 'skill', name: 'deploy-app' })
    expect(parseSlashToken('command:compact')).toEqual({ type: 'command', name: 'compact' })
  })

  it('treats a bare name as a skill', () => {
    expect(parseSlashToken('deploy-app')).toEqual({ type: 'skill', name: 'deploy-app' })
  })
})
