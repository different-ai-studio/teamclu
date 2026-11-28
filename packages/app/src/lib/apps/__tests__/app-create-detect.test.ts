import { describe, expect, it } from 'vitest'

import { detectCreatedApp, detectCreatedAppInMessage } from '@/lib/apps/app-create-detect'
import type { ToolCall } from '@/stores/session-types'

const ENVELOPE = JSON.stringify({
  v: 1,
  ok: true,
  data: { ok: true, action: 'create', app: { id: 'app-1', name: '报销助手' }, checkout: { outcome: 'seeded' } },
})

function bash(command: string, result: unknown, status: ToolCall['status'] = 'completed'): ToolCall {
  return {
    id: `tc-${Math.random()}`,
    name: 'bash',
    status,
    arguments: { command },
    result,
    startTime: new Date(0),
  }
}

describe('detectCreatedApp', () => {
  it('reads the app from a finished amuxd app create', () => {
    expect(detectCreatedApp(bash('amuxd app create --name 报销助手', ENVELOPE))).toEqual({
      appId: 'app-1',
      appName: '报销助手',
    })
  })

  it('finds the envelope among other output and in a command chain', () => {
    const output = `Cloning…\n${ENVELOPE}\n`
    expect(detectCreatedApp(bash('cd /tmp && amuxd app create --name x', output))?.appId).toBe('app-1')
  })

  it('reads the output wherever the tool result keeps it', () => {
    expect(detectCreatedApp(bash('amuxd app create', { output: ENVELOPE }))?.appId).toBe('app-1')
  })

  it('still offers an app whose checkout failed', () => {
    const failedCheckout = JSON.stringify({
      v: 1,
      ok: true,
      data: { ok: false, action: 'create', app: { id: 'app-2', name: 'y' }, checkout: { outcome: 'failed' } },
    })
    expect(detectCreatedApp(bash('amuxd app create', failedCheckout))?.appId).toBe('app-2')
  })

  it('ignores a refused create, other actions and other commands', () => {
    const refused = JSON.stringify({ v: 1, ok: false, error: { code: 'forbidden' } })
    expect(detectCreatedApp(bash('amuxd app create', refused))).toBeNull()
    const status = JSON.stringify({ v: 1, ok: true, data: { action: 'status', app: { id: 'app-1' } } })
    expect(detectCreatedApp(bash('amuxd app show', status))).toBeNull()
    expect(detectCreatedApp(bash('echo amuxd-app create', ENVELOPE))).toBeNull()
    expect(detectCreatedApp(bash('amuxd app create', 'not json'))).toBeNull()
  })

  it('waits for the call to finish', () => {
    expect(detectCreatedApp(bash('amuxd app create', ENVELOPE, 'calling'))).toBeNull()
    expect(detectCreatedApp(bash('amuxd app create', ENVELOPE, 'failed'))).toBeNull()
  })
})

describe('detectCreatedAppInMessage', () => {
  it('takes the last app created in the message, from parts first', () => {
    const second = ENVELOPE.replace('app-1', 'app-3')
    const message = {
      parts: [
        { id: 'p1', type: 'tool-call', toolCall: bash('amuxd app create', ENVELOPE) },
        { id: 'p2', type: 'text', content: 'done' },
        { id: 'p3', type: 'tool-call', toolCall: bash('amuxd app create', second) },
      ],
      toolCalls: [],
    }
    expect(detectCreatedAppInMessage(message)?.appId).toBe('app-3')
  })

  it('falls back to toolCalls when the message has no tool parts', () => {
    expect(
      detectCreatedAppInMessage({ parts: [], toolCalls: [bash('amuxd app create', ENVELOPE)] })?.appId,
    ).toBe('app-1')
  })
})
