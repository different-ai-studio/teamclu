import assert from 'node:assert/strict'
import test from 'node:test'

import {
  settleAllPermissions,
  settlePermissionsForSession,
} from './permission-registry.mjs'

test('settlePermissionsForSession only affects the matching session', () => {
  /** @type {Map<string, { sessionKey: string, settle: (v: unknown) => void, input: unknown }>} */
  const pending = new Map()
  const settled = []

  pending.set('perm-a', {
    sessionKey: 'sess-a',
    input: {},
    settle: (v) => settled.push(['a', v]),
  })
  pending.set('perm-b', {
    sessionKey: 'sess-b',
    input: {},
    settle: (v) => settled.push(['b', v]),
  })

  settlePermissionsForSession(pending, 'sess-a', { behavior: 'deny' })

  assert.deepEqual(settled, [['a', { behavior: 'deny' }]])
  assert.equal(pending.size, 1)
  assert.ok(pending.has('perm-b'))
})

test('settleAllPermissions clears every pending entry', () => {
  const pending = new Map()
  let count = 0
  pending.set('perm-1', {
    sessionKey: 'sess-a',
    input: {},
    settle: () => {
      count += 1
    },
  })
  pending.set('perm-2', {
    sessionKey: 'sess-b',
    input: {},
    settle: () => {
      count += 1
    },
  })

  settleAllPermissions(pending, { behavior: 'deny' })
  assert.equal(count, 2)
  assert.equal(pending.size, 0)
})
