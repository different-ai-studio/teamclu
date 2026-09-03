import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authState } = vi.hoisted(() => ({
  authState: {
    pendingInviteToken: null as string | null,
    setPendingInviteToken: vi.fn((token: string | null) => {
      authState.pendingInviteToken = token
    }),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => authState },
}))

import {
  confirmInviteLinkToken,
  isInviteLinkConfirmed,
  requestInviteLinkConfirmation,
  resetInviteLinkConfirmationForTests,
  useInviteLinkConfirmation,
  whenDocumentFocused,
} from '@/lib/team/invite-link-confirmation'

beforeEach(() => {
  resetInviteLinkConfirmationForTests()
  authState.pendingInviteToken = null
  authState.setPendingInviteToken.mockClear()
})

describe('invite link confirmation', () => {
  it('a requested token is not confirmed until the user accepts', () => {
    requestInviteLinkConfirmation('tok-1')
    expect(useInviteLinkConfirmation.getState().requested).toBe('tok-1')
    expect(isInviteLinkConfirmed('tok-1')).toBe(false)
    // Nothing is stashed on request alone — the OS handing us a URL is not consent.
    expect(authState.setPendingInviteToken).not.toHaveBeenCalled()
  })

  it('accept confirms the token and stashes it for AuthGate to claim', () => {
    requestInviteLinkConfirmation('tok-1')
    useInviteLinkConfirmation.getState().accept()
    expect(useInviteLinkConfirmation.getState().requested).toBeNull()
    expect(isInviteLinkConfirmed('tok-1')).toBe(true)
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith('tok-1')
  })

  it('does not ask again for a token already accepted this run', () => {
    confirmInviteLinkToken('tok-1')
    requestInviteLinkConfirmation('tok-1')
    expect(useInviteLinkConfirmation.getState().requested).toBeNull()
  })

  it('dismiss drops the dialog and clears a matching stashed token', () => {
    authState.pendingInviteToken = 'tok-1'
    requestInviteLinkConfirmation('tok-1')
    useInviteLinkConfirmation.getState().dismiss()
    expect(useInviteLinkConfirmation.getState().requested).toBeNull()
    expect(isInviteLinkConfirmed('tok-1')).toBe(false)
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith(null)
  })

  it('dismiss leaves a different stashed token alone', () => {
    authState.pendingInviteToken = 'tok-other'
    requestInviteLinkConfirmation('tok-1')
    useInviteLinkConfirmation.getState().dismiss()
    expect(authState.setPendingInviteToken).not.toHaveBeenCalled()
    expect(authState.pendingInviteToken).toBe('tok-other')
  })
})

describe('whenDocumentFocused', () => {
  it('runs immediately when the document already has focus', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const fn = vi.fn()
    whenDocumentFocused(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    hasFocus.mockRestore()
  })

  it('defers until the window gains focus', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const fn = vi.fn()
    whenDocumentFocused(fn)
    expect(fn).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    expect(fn).toHaveBeenCalledTimes(1)
    // One-shot: a later focus does not re-run it.
    window.dispatchEvent(new Event('focus'))
    expect(fn).toHaveBeenCalledTimes(1)
    hasFocus.mockRestore()
  })

  it('cancel stops a deferred run', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const fn = vi.fn()
    const cancel = whenDocumentFocused(fn)
    cancel()
    window.dispatchEvent(new Event('focus'))
    expect(fn).not.toHaveBeenCalled()
    hasFocus.mockRestore()
  })
})
