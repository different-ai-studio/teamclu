import { describe, it, expect, vi, beforeEach } from 'vitest'

// Set up mock localStorage before importing the module
const mockStore: Record<string, string> = {}
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStore[key] = value
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStore[key]
  }),
  clear: vi.fn(() => {
    Object.keys(mockStore).forEach((k) => delete mockStore[k])
  }),
  length: 0,
  key: vi.fn(() => null),
}

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

import {
  shouldAutoAuthorize,
  setPermissionPolicy,
  setBatchDone,
} from '@/lib/agent/permission-policy'

describe('permission-policy', () => {
  beforeEach(() => {
    mockLocalStorage.clear()
    vi.clearAllMocks()
    // Re-bind mock so calls still go through
    mockLocalStorage.getItem.mockImplementation((key: string) => mockStore[key] ?? null)
    mockLocalStorage.setItem.mockImplementation((key: string, value: string) => {
      mockStore[key] = value
    })
  })

  it('returns false when policy is ask (default)', () => {
    // No policy set — defaults to 'ask'
    expect(shouldAutoAuthorize()).toBe(false)
  })

  it('returns true when policy is bypass', () => {
    setPermissionPolicy('bypass')
    expect(shouldAutoAuthorize()).toBe(true)
  })

  it('returns true when policy is batch and batch is done', () => {
    setPermissionPolicy('batch')
    setBatchDone(true)
    expect(shouldAutoAuthorize()).toBe(true)
  })

  it('returns false when policy is batch but batch is not done', () => {
    setPermissionPolicy('batch')
    setBatchDone(false)
    expect(shouldAutoAuthorize()).toBe(false)
  })
})
