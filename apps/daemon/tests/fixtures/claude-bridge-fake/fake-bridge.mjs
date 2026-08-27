#!/usr/bin/env node
/**
 * Hermetic fake claude-bridge for amuxd integration tests.
 * Same JSONL RPC contract as claude-bridge; no SDK or network.
 */
import readline from 'node:readline'
import { randomBytes } from 'node:crypto'

/** @type {Map<string, { sessionId: string, model: string }>} */
const sessions = new Map()
/** @type {Map<string, { sessionKey: string, resolve: (v: unknown) => void }>} */
const pendingPermissions = new Map()

let nextSessionId = 1
let nextPermissionId = 1

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function settlePermissionsForSession(sessionKey, result) {
  for (const [requestId, pending] of pendingPermissions) {
    if (pending.sessionKey !== sessionKey) continue
    pendingPermissions.delete(requestId)
    pending.resolve(result)
  }
}

async function runTurn(sessionKey, text) {
  const session = sessions.get(sessionKey)
  if (!session) return

  emit({ event: 'turn_start', sessionId: sessionKey })

  if (text === '__crash_bridge__') {
    setImmediate(() => process.exit(0))
    return
  }

  if (text.startsWith('perm:')) {
    const requestId = `perm-${nextPermissionId++}`
    await new Promise((resolve) => {
      pendingPermissions.set(requestId, { sessionKey, resolve })
      emit({
        event: 'permission_request',
        sessionId: sessionKey,
        requestId,
        toolName: 'Bash',
        input: { command: 'echo test' },
        canAlways: false,
        suggestions: [],
      })
    })
  } else {
    emit({ event: 'assistant_delta', sessionId: sessionKey, text: `echo:${text}` })
  }

  emit({
    event: 'turn_end',
    sessionId: sessionKey,
    status: 'success',
    model: session.model,
  })
}

async function createSession(params, resume) {
  const sessionKey = `sess-${nextSessionId++}`
  const sessionId =
    resume || `fake-sdk-${sessionKey}-${randomBytes(4).toString('hex')}`
  const model = params.model || 'claude-opus'
  sessions.set(sessionKey, { sessionId, model })
  if (params.initialPrompt) void runTurn(sessionKey, params.initialPrompt)
  return { sessionKey, sessionId, model }
}

async function handleRequest(req) {
  const { id, method, params = {} } = req
  try {
    switch (method) {
      case 'list_models':
        emit({
          id,
          result: {
            models: [
              { id: 'claude/claude-opus', displayName: 'Opus', providerName: 'claude' },
              { id: 'claude/claude-sonnet', displayName: 'Sonnet', providerName: 'claude' },
            ],
          },
        })
        break
      case 'create_session':
      case 'resume_session': {
        const resume = method === 'resume_session' ? params.sessionId : undefined
        if (method === 'resume_session' && !resume) throw new Error('sessionId is required')
        emit({ id, result: await createSession(params, resume) })
        break
      }
      case 'send': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        if (!params.text) throw new Error('text is required')
        void runTurn(params.sessionKey, params.text)
        emit({ id, result: { ok: true } })
        break
      }
      case 'cancel': {
        emit({
          event: 'turn_end',
          sessionId: params.sessionKey,
          status: 'cancelled',
          model: sessions.get(params.sessionKey)?.model ?? '',
        })
        emit({ id, result: { ok: true } })
        break
      }
      case 'set_model': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        if (params.model === 'invalid-model') {
          emit({ id, error: 'model not available' })
          break
        }
        session.model = params.model ?? session.model
        emit({ id, result: { model: session.model } })
        break
      }
      case 'resolve_permission': {
        const pending = pendingPermissions.get(params.requestId)
        if (!pending) {
          emit({ id, result: { ok: false, reason: 'unknown request' } })
          break
        }
        pendingPermissions.delete(params.requestId)
        pending.resolve(params.granted ? 'ok' : 'denied')
        emit({ id, result: { ok: true } })
        break
      }
      case 'close_session': {
        settlePermissionsForSession(params.sessionKey, 'denied')
        sessions.delete(params.sessionKey)
        emit({ id, result: { ok: true } })
        break
      }
      default:
        emit({ id, error: `unknown method: ${method}` })
    }
  } catch (err) {
    emit({ id, error: String(err?.message ?? err) })
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of rl) {
  const trimmed = line.trim()
  if (!trimmed) continue
  try {
    const req = JSON.parse(trimmed)
    if (req?.method && req?.id != null) void handleRequest(req)
  } catch {
    // ignore malformed lines
  }
}
