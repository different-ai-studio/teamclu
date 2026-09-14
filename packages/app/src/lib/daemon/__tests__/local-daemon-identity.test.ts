import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  __resetLocalDaemonIdentityForTest,
  isSupersededLocalAgent,
  noteLocalDaemonActorId,
  subscribeLocalDaemonActorId,
  wasEverLocalDaemonIdentity,
} from '@/lib/daemon/local-daemon-identity'
import { appShortName } from '@/lib/config/build-config'

const STORAGE_KEY = `${appShortName}-local-daemon-actor-id`

describe('local-daemon-identity', () => {
  beforeEach(() => {
    __resetLocalDaemonIdentityForTest()
  })

  it('marks a persisted actor id superseded after daemon identity changes', () => {
    localStorage.setItem(STORAGE_KEY, 'old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(isSupersededLocalAgent('old-macpro')).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('new-local')
  })

  it('marks in-session identity changes superseded', () => {
    noteLocalDaemonActorId('old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(isSupersededLocalAgent('old-macpro')).toBe(true)
  })

  it('wasEverLocalDaemonIdentity is false for remote teammate agents', () => {
    localStorage.setItem(STORAGE_KEY, 'invitee-local')
    noteLocalDaemonActorId('invitee-local')
    expect(wasEverLocalDaemonIdentity('creator-gg-bot')).toBe(false)
  })

  it('wasEverLocalDaemonIdentity is true for superseded local ids', () => {
    noteLocalDaemonActorId('old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(wasEverLocalDaemonIdentity('old-macpro')).toBe(true)
  })

  it('wasEverLocalDaemonIdentity catches transition window before superseded set', () => {
    localStorage.setItem(STORAGE_KEY, 'old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(wasEverLocalDaemonIdentity('old-macpro')).toBe(true)
  })

  it('wasEverLocalDaemonIdentity is false for current local id', () => {
    noteLocalDaemonActorId('current-local')
    expect(wasEverLocalDaemonIdentity('current-local')).toBe(false)
  })

  it('un-stales an actor when it becomes the current local id again', () => {
    noteLocalDaemonActorId('kfc')
    noteLocalDaemonActorId('other-team')
    expect(isSupersededLocalAgent('kfc')).toBe(true)

    noteLocalDaemonActorId('kfc')
    expect(isSupersededLocalAgent('kfc')).toBe(false)
    expect(wasEverLocalDaemonIdentity('kfc')).toBe(false)
    expect(isSupersededLocalAgent('other-team')).toBe(true)
  })

  it('notifies subscribers when the known id changes, and only then', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocalDaemonActorId(listener)
    noteLocalDaemonActorId('old-team')
    noteLocalDaemonActorId('old-team')
    noteLocalDaemonActorId(null)
    expect(listener).toHaveBeenCalledTimes(1)

    noteLocalDaemonActorId('new-team')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    noteLocalDaemonActorId('third-team')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  // On app start the known id is the persisted one; the first probe that merely
  // confirms it is not a change.
  it('does not notify when a probe confirms the persisted id', () => {
    localStorage.setItem(STORAGE_KEY, 'same-local')
    const listener = vi.fn()
    const unsubscribe = subscribeLocalDaemonActorId(listener)
    noteLocalDaemonActorId('same-local')
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
