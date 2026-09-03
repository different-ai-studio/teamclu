import { describe, expect, it } from 'vitest'

import { MessageKind } from '@/lib/proto/teamclu_pb'
import { resolveSessionEstablishedModel } from '@/lib/session/session-established-model'

describe('resolveSessionEstablishedModel', () => {
  const agent = 'agent-local'

  it("prefers the agent's own latest modeled message", () => {
    const model = resolveSessionEstablishedModel(
      [
        { model: 'big-pickle', senderActorId: agent, kind: MessageKind.AGENT_REPLY },
        { model: 'qwen3.6-plus', senderActorId: 'user-1', kind: MessageKind.TEXT },
      ],
      agent,
    )

    expect(model).toBe('big-pickle')
  })

  it("falls back to the user's own message when the agent has not replied yet", () => {
    const model = resolveSessionEstablishedModel(
      [{ model: 'qwen3.6-plus', senderActorId: 'user-1', kind: MessageKind.TEXT }],
      agent,
    )

    expect(model).toBe('qwen3.6-plus')
  })

  it('never inherits another agent\'s model', () => {
    // "switch to local agent": the transcript is all remote-agent replies.
    const model = resolveSessionEstablishedModel(
      [
        { model: 'claude-sonnet-4-6', senderActorId: 'agent-remote', kind: MessageKind.AGENT_REPLY },
        { model: 'claude-sonnet-4-6', senderActorId: 'agent-remote', kind: MessageKind.AGENT_THINKING },
      ],
      agent,
    )

    expect(model).toBeNull()
  })

  it('skips another agent\'s reply but still sees an older user message', () => {
    const model = resolveSessionEstablishedModel(
      [
        { model: 'qwen3.6-plus', senderActorId: 'user-1', kind: MessageKind.TEXT },
        { model: 'claude-sonnet-4-6', senderActorId: 'agent-remote', kind: MessageKind.AGENT_REPLY },
      ],
      agent,
    )

    expect(model).toBe('qwen3.6-plus')
  })

  it('returns null for an empty transcript or a missing agent id', () => {
    expect(resolveSessionEstablishedModel([], agent)).toBeNull()
    expect(resolveSessionEstablishedModel(undefined, agent)).toBeNull()
    expect(
      resolveSessionEstablishedModel(
        [{ model: 'big-pickle', senderActorId: agent, kind: MessageKind.AGENT_REPLY }],
        '  ',
      ),
    ).toBeNull()
  })
})
