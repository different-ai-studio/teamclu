import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `runPiLogin` is the client half of pi's `/login`: it polls the daemon, hands
 * pi's questions to the UI, and posts the answers back. The daemon transport is
 * mocked so these exercise the state machine itself — the parts that are easy
 * to get wrong and impossible to see in a screenshot.
 */

const daemonRequest = vi.fn()
vi.mock('@/lib/daemon-local-client', () => ({
  daemonRequest: (path: string, init?: RequestInit) => daemonRequest(path, init),
}))

const { runPiLogin, PI_LOGIN_SILENT_ERROR } = await import('@/lib/daemon-pi-auth')

type Snapshot = {
  provider_id: string
  status: 'running' | 'succeeded' | 'failed'
  events: unknown[]
  cursor: number
  prompt: { prompt_id: string; prompt: unknown } | null
  error: string | null
  refresh_error: string | null
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    provider_id: 'openai-codex',
    status: 'running',
    events: [],
    cursor: 0,
    prompt: null,
    error: null,
    refresh_error: null,
    ...over,
  }
}

/**
 * Serve a scripted sequence of poll responses. The last entry repeats, so a
 * loop that polls once more than expected still terminates instead of hanging
 * the test.
 */
function scriptPolls(sequence: Snapshot[]) {
  let index = 0
  daemonRequest.mockImplementation(async (path: string) => {
    if (path === '/v1/pi/logins') return { loginId: 'L1' }
    if (path.includes('/respond') || path.includes('/cancel')) return { ok: true }
    const next = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    return next
  })
}

function calls(fragment: string) {
  return daemonRequest.mock.calls.filter(([path]: [string]) => String(path).includes(fragment))
}

describe('runPiLogin', () => {
  beforeEach(() => {
    daemonRequest.mockReset()
  })

  it('answers a prompt and reports the terminal outcome', async () => {
    scriptPolls([
      snapshot({
        events: [{ type: 'auth_url', url: 'https://auth.example/x' }],
        cursor: 1,
        prompt: { prompt_id: 'p1', prompt: { type: 'manual_code', message: 'Paste' } },
      }),
      snapshot({ cursor: 1, status: 'succeeded' }),
    ])

    const events: unknown[] = []
    const outcome = await runPiLogin('openai-codex', 'oauth', {
      onEvent: (event) => events.push(event),
      onPrompt: async () => 'the-code',
    })

    expect(outcome).toEqual({ status: 'succeeded', error: null, refreshError: null })
    expect(events).toEqual([{ type: 'auth_url', url: 'https://auth.example/x' }])

    const [, init] = calls('/respond')[0]
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      promptId: 'p1',
      value: 'the-code',
      cancelled: false,
    })
  })

  /**
   * The cursor is what stops a re-render from replaying the whole flow: each
   * poll asks only for what it has not seen. A client that always sent 0 would
   * show the authorize URL again on every tick.
   */
  it('advances the cursor so events are delivered exactly once', async () => {
    scriptPolls([
      snapshot({ events: [{ type: 'progress', message: 'one' }], cursor: 1 }),
      snapshot({ events: [{ type: 'progress', message: 'two' }], cursor: 2 }),
      snapshot({ cursor: 2, status: 'succeeded' }),
    ])

    const events: unknown[] = []
    await runPiLogin('anthropic', 'oauth', {
      onEvent: (event) => events.push(event),
      onPrompt: async () => null,
    })

    expect(events).toEqual([
      { type: 'progress', message: 'one' },
      { type: 'progress', message: 'two' },
    ])
    const cursors = calls('/v1/pi/logins/L1').map(([path]: [string]) =>
      new URL(String(path), 'http://x').searchParams.get('cursor'),
    )
    expect(cursors.slice(0, 3)).toEqual(['0', '1', '2'])
  })

  /**
   * pi races its "paste the code" prompt against its own loopback callback
   * server and withdraws it when the callback wins. The UI has to be told, or
   * it leaves a dead input on screen and the user keeps typing into nothing.
   */
  it('aborts a prompt pi has withdrawn', async () => {
    scriptPolls([
      snapshot({ prompt: { prompt_id: 'p1', prompt: { type: 'manual_code', message: 'Paste' } } }),
      snapshot({ prompt: null }),
      snapshot({ status: 'succeeded' }),
    ])

    let aborted = false
    await runPiLogin('openrouter', 'oauth', {
      onEvent: () => {},
      // Never resolves on its own — only the abort can end it, which is the
      // point: a UI that ignored the signal would hang the login here.
      onPrompt: (_prompt, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve(null)
          })
        }),
    })

    expect(aborted).toBe(true)
  })

  /**
   * Answering `null` is a refusal, and pi treats a refused prompt as a
   * cancelled login — so it has to go back as `cancelled`, not as an empty
   * string, which is a legitimate answer for optional prompts.
   */
  it('sends a refusal as cancelled rather than an empty answer', async () => {
    scriptPolls([
      snapshot({ prompt: { prompt_id: 'p1', prompt: { type: 'secret', message: 'Key' } } }),
      snapshot({ status: 'failed', error: 'Login cancelled' }),
    ])

    const outcome = await runPiLogin('deepseek', 'api_key', {
      onEvent: () => {},
      onPrompt: async () => null,
    })

    expect(outcome.status).toBe('failed')
    const [, init] = calls('/respond')[0]
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      cancelled: true,
      value: null,
    })
  })

  /** An empty string is an answer (pressing enter for "github.com"). */
  it('sends an empty answer as an answer', async () => {
    scriptPolls([
      snapshot({ prompt: { prompt_id: 'p1', prompt: { type: 'text', message: 'Domain' } } }),
      snapshot({ status: 'succeeded' }),
    ])

    await runPiLogin('github-copilot', 'oauth', {
      onEvent: () => {},
      onPrompt: async () => '',
    })

    const [, init] = calls('/respond')[0]
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      cancelled: false,
      value: '',
    })
  })

  /** Closing the dialog must cancel the flow in the daemon too, or pi sits
   * waiting on an answer that is never coming. */
  it('cancels the daemon-side flow when aborted', async () => {
    scriptPolls([snapshot()])
    const controller = new AbortController()
    const promise = runPiLogin(
      'xai',
      'oauth',
      { onEvent: () => {}, onPrompt: async () => null },
      { abort: controller.signal },
    )
    // Let the first poll land before aborting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await promise
    expect(calls('/cancel').length).toBeGreaterThan(0)
  })

  /**
   * The failure this whole timeout exists for: pi accepts the login, then says
   * nothing at all. Before, that left "waiting for authorization" on screen
   * forever with no browser, no error and no end — the one failure a user
   * cannot act on. It must terminate, and it must cancel the daemon-side flow
   * on the way out so pi is not left waiting on an answer nobody will give.
   */
  it('gives up on a flow that never produces an event, and cancels it', async () => {
    vi.useFakeTimers()
    try {
      scriptPolls([snapshot()])
      const promise = runPiLogin('ant-ling', 'api_key', {
        onEvent: () => {},
        onPrompt: async () => null,
      })
      // Past the opening deadline; the loop needs its polls to run, so time is
      // advanced in slices rather than one jump.
      for (let i = 0; i < 200; i += 1) await vi.advanceTimersByTimeAsync(500)
      const outcome = await promise
      expect(outcome.status).toBe('failed')
      expect(outcome.error).toBe(PI_LOGIN_SILENT_ERROR)
      expect(calls('/cancel').length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  /** A flow that says something keeps its patience: the deadline is only for
   * the opening, or a user reading a browser page would be cut off. */
  it('does not time out once pi has spoken', async () => {
    vi.useFakeTimers()
    try {
      scriptPolls([
        snapshot({ events: [{ type: 'progress', message: 'working' }], cursor: 1 }),
        snapshot({ cursor: 1 }),
      ])
      let settled = false
      const promise = runPiLogin('anthropic', 'oauth', {
        onEvent: () => {},
        onPrompt: async () => null,
      }).then((r) => {
        settled = true
        return r
      })
      for (let i = 0; i < 200; i += 1) await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBe(false)
      expect(calls('/cancel').length).toBe(0)
      void promise
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A single failed poll is survivable — the daemon restarting, or a request
   * landing mid token-exchange. A run of them is not, and must end the login
   * rather than spin forever.
   */
  it('tolerates a transient poll failure but gives up on a sustained one', async () => {
    let polls = 0
    daemonRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/pi/logins') return { loginId: 'L1' }
      polls += 1
      if (polls === 1) throw new Error('temporarily unreachable')
      if (polls === 2) return snapshot({ status: 'succeeded' })
      throw new Error('unexpected extra poll')
    })

    const recovered = await runPiLogin('anthropic', 'oauth', {
      onEvent: () => {},
      onPrompt: async () => null,
    })
    expect(recovered.status).toBe('succeeded')

    daemonRequest.mockImplementation(async (path: string) => {
      if (path === '/v1/pi/logins') return { loginId: 'L2' }
      throw new Error('daemon gone')
    })
    const lost = await runPiLogin('anthropic', 'oauth', {
      onEvent: () => {},
      onPrompt: async () => null,
    })
    expect(lost.status).toBe('failed')
    expect(lost.error).toContain('daemon gone')
  })
})
