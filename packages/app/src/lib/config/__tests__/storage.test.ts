import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadFromStorage, saveToStorage } from '@/lib/config/storage'

// Mock localStorage since vitest runs in node environment
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

beforeEach(() => {
  mockLocalStorage.clear()
  vi.clearAllMocks()
})

describe('loadFromStorage', () => {
  it('returns fallback when key is missing', () => {
    expect(loadFromStorage('nonexistent', 42)).toBe(42)
  })

  it('returns parsed value when key exists', () => {
    mockStore['test-key'] = JSON.stringify({ a: 1 })
    expect(loadFromStorage('test-key', {})).toEqual({ a: 1 })
  })

  it('returns fallback on invalid JSON', () => {
    mockStore['bad-json'] = '{not valid json'
    expect(loadFromStorage('bad-json', 'default')).toBe('default')
  })
})

describe('saveToStorage', () => {
  it('saves serialized value', () => {
    saveToStorage('save-key', { x: 10 })
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('save-key', JSON.stringify({ x: 10 }))
  })

  it('does not throw on storage error', () => {
    mockLocalStorage.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveToStorage('key', 'val')).not.toThrow()
  })
})
