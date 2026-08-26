#!/usr/bin/env node
/**
 * JSONL RPC bridge between amuxd (Rust) and @anthropic-ai/claude-agent-sdk.
 *
 * Same wire protocol as cursor-bridge, so the Rust client/process/event layers
 * are shared shapes:
 *   Request:  { "id": "...", "method": "...", "params": { ... } }
 *   Response: { "id": "...", "result": { ... } }
 *   Error:    { "id": "...", "error": "..." }
 *   Event:    { "event": "...", "sessionId": "...", ... }
 *
 * The Agent SDK runs in *streaming input* mode: each session owns an async
 * iterable of user messages that we push into, which is what makes
 * `interrupt()` / `setModel()` / `setPermissionMode()` available at all — they
 * are control-protocol calls and only exist on a streaming query.
 */
import readline from 'node:readline'
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk'

import { mcpServersOption } from './mcp-servers-claude.mjs'
import { repairTranscript } from './transcript-repair.mjs'

/**
 * @typedef {{
 *   q: import('@anthropic-ai/claude-agent-sdk').Query,
 *   input: PushQueue,
 *   cwd: string,
 *   sessionId: string,
 *   model: string,
 *   turnActive: boolean,
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map()
/**
 * In-flight `startSession` for a model probe, so two concurrent `list_models`
 * calls do not each spawn a session. Cleared when it settles.
 */
let modelProbeSession = null

/** requestId → resolve fn for a pending canUseTool callback. */
const pendingPermissions = new Map()

let nextPermissionId = 1

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/**
 * Push-driven async iterable. The SDK pulls user messages from this; `push`
 * hands one over (waking a blocked pull), `close` ends the session's input.
 */
class PushQueue {
  constructor() {
    this.items = []
    this.waiting = []
    this.done = false
  }

  push(item) {
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.done = true
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

function userMessage(text, sessionId) {
  return {
    type: 'user',
    session_id: sessionId ?? '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function paramsToObject(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { input: JSON.stringify(input ?? null) }
  }
  const out = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

function toolResultText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * The permission gate. Blocks until amuxd answers, so the daemon — not this
 * process — decides how long a human may take. `full_access` sessions never
 * reach here: they run with permissionMode `bypassPermissions`.
 */
function makeCanUseTool(sessionKey) {
  return (toolName, input, { signal, suggestions, toolUseID }) =>
    new Promise((resolve) => {
      const requestId = `perm-${nextPermissionId++}`
      const settle = (result) => {
        if (!pendingPermissions.delete(requestId)) return
        resolve(result)
      }
      pendingPermissions.set(requestId, { settle, input })

      // An aborted turn must not leave the SDK waiting on us forever.
      signal?.addEventListener?.('abort', () =>
        settle({ behavior: 'deny', message: 'Turn was cancelled.', interrupt: true }),
      )

      emit({
        event: 'permission_request',
        sessionId: sessionKey,
        requestId,
        toolName,
        toolUseId: toolUseID,
        input: paramsToObject(input),
        // Non-empty means the SDK can persist an "always allow" for this tool.
        canAlways: Array.isArray(suggestions) && suggestions.length > 0,
        suggestions: suggestions ?? [],
      })
    })
}

function handleAssistantMessage(sessionKey, session, message) {
  // Top-level text/thinking already streamed through stream_event deltas
  // (includePartialMessages); re-emitting the completed block would duplicate
  // it. Subagent messages (parent_tool_use_id set) never stream, keep whole.
  const topLevel = message.parent_tool_use_id == null
  for (const block of message.message?.content ?? []) {
    if (block.type === 'text' && block.text) {
      if (!(topLevel && session.streamedText)) {
        emit({ event: 'assistant_delta', sessionId: sessionKey, text: block.text })
      }
    } else if (block.type === 'thinking' && block.thinking) {
      if (!(topLevel && session.streamedThinking)) {
        emit({ event: 'thinking_delta', sessionId: sessionKey, text: block.thinking })
      }
    } else if (block.type === 'tool_use') {
      emit({
        event: 'tool_start',
        sessionId: sessionKey,
        toolCallId: block.id,
        toolName: block.name,
        args: paramsToObject(block.input),
      })
    }
  }
  if (topLevel) {
    session.streamedText = false
    session.streamedThinking = false
  }
}

/** Token-level streaming (includePartialMessages). Top-level content only. */
function handleStreamEvent(sessionKey, session, message) {
  if (message.parent_tool_use_id != null) return
  const ev = message.event
  if (ev?.type !== 'content_block_delta') return
  const delta = ev.delta
  if (delta?.type === 'text_delta' && delta.text) {
    session.streamedText = true
    emit({ event: 'assistant_delta', sessionId: sessionKey, text: delta.text })
  } else if (delta?.type === 'thinking_delta' && delta.thinking) {
    session.streamedThinking = true
    emit({ event: 'thinking_delta', sessionId: sessionKey, text: delta.thinking })
  }
}

/** Tool results arrive as `user` messages carrying tool_result blocks. */
function handleUserMessage(sessionKey, message) {
  const content = message.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    emit({
      event: 'tool_end',
      sessionId: sessionKey,
      toolCallId: block.tool_use_id,
      summary: toolResultText(block.content),
      isError: block.is_error === true,
    })
  }
}

async function pumpSession(sessionKey, session) {
  try {
    for await (const message of session.q) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            session.sessionId = message.session_id
            session.model = message.model ?? session.model
            void emitSlashCommands(sessionKey, session.q, message.slash_commands ?? [])
          }
          break
        case 'assistant':
          if (!session.priming) handleAssistantMessage(sessionKey, session, message)
          break
        case 'stream_event':
          if (!session.priming) handleStreamEvent(sessionKey, session, message)
          break
        case 'user':
          if (!session.priming) handleUserMessage(sessionKey, message)
          break
        case 'result': {
          // Errors surface even for the invisible priming turn — if that turn
          // failed (auth, model access), every later turn will fail the same
          // way and hiding it would leave the user staring at silence.
          if (message.subtype !== 'success') {
            emit({
              event: 'run_error',
              sessionId: sessionKey,
              message: (message.errors ?? []).join('; ') || message.subtype,
            })
          }
          // modelUsage is keyed by the model that actually ran the turn — the
          // authoritative reading, unlike whatever we last asked for.
          const used = Object.keys(message.modelUsage ?? {})
          if (used.length > 0) session.model = used[used.length - 1]
          const wasPriming = session.priming
          session.priming = false
          session.turnActive = false
          session.streamedText = false
          session.streamedThinking = false
          if (!wasPriming) {
            emit({
              event: 'turn_end',
              sessionId: sessionKey,
              status: message.subtype,
              model: session.model,
              costUsd: message.total_cost_usd,
            })
          }
          // A send that arrived mid-turn was queued; its turn begins only now,
          // so its turn_start cannot be closed by the previous turn's result.
          if (session.pendingTurnStarts > 0) {
            session.pendingTurnStarts -= 1
            session.turnActive = true
            emit({ event: 'turn_start', sessionId: sessionKey })
          }
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    if (!(err instanceof AbortError)) {
      emit({ event: 'run_error', sessionId: sessionKey, message: String(err?.message ?? err) })
    }
    session.priming = false
    session.pendingTurnStarts = 0
    session.turnActive = false
    emit({ event: 'turn_end', sessionId: sessionKey, status: 'error' })
  } finally {
    // Nothing more will arrive for this session; release anything still blocked.
    for (const [requestId, pending] of [...pendingPermissions]) {
      pending.settle({ behavior: 'deny', message: 'Session ended.', interrupt: true })
      pendingPermissions.delete(requestId)
    }
  }
}

async function emitSlashCommands(sessionKey, q, fallbackNames = []) {
  try {
    const cmds = await q.supportedCommands()
    if (cmds.length > 0) {
      emit({
        event: 'slash_commands',
        sessionId: sessionKey,
        commands: cmds.map((c) => ({
          name: c.name,
          description: c.description ?? '',
          inputHint: c.argumentHint ?? '',
        })),
      })
      return
    }
  } catch {
    // Fall back to init-time names when supportedCommands is unavailable.
  }
  if (fallbackNames.length > 0) {
    emit({
      event: 'slash_commands',
      sessionId: sessionKey,
      commands: fallbackNames.map((name) => ({ name, description: '', inputHint: '' })),
    })
  }
}

async function startSession(params, resume) {
  const cwd = params.cwd
  if (!cwd) throw new Error('cwd is required')
  const sessionKey = `pending-${nextPermissionId++}`
  const input = new PushQueue()

  // The SDK replays its own transcript on resume, so one invalid record bricks
  // the session for good: every later turn re-sends it and the API rejects the
  // request before the model runs. Interrupting a tool call has been observed
  // to leave the interrupted tool's result recorded twice in one message, which
  // trips "tool_use ids must be unique". Fix it here, where we still can.
  if (resume) {
    const repair = repairTranscript(resume)
    if (repair.repaired) {
      emit({
        event: 'transcript_repaired',
        sessionId: sessionKey,
        resume,
        path: repair.path,
        backup: repair.backup,
        removed: repair.removed.length,
      })
    } else if (repair.error) {
      // Not fatal: an unrepaired transcript may still be perfectly valid.
      emit({ event: 'transcript_repair_failed', sessionId: sessionKey, resume, message: repair.error })
    }
  }

  const fullAccess = params.permissionMode === 'bypassPermissions'
  const q = query({
    prompt: input,
    options: {
      cwd,
      ...(params.model ? { model: params.model } : {}),
      ...(resume ? { resume } : {}),
      ...mcpServersOption(params.mcpServers),
      permissionMode: params.permissionMode ?? 'default',
      // "project" loads <cwd>/.claude/settings.json and .claude/skills/ without
      // pulling in ~/.claude/* (user scope would bypass canUseTool via personal
      // permissions.allow rules and flood sessions with personal skills).
      settingSources: ['project'],
      // Skills the user explicitly invokes must not stall on an approval
      // popover; the tools a skill then runs are still gated individually.
      allowedTools: ['Skill'],
      // Token-level deltas (stream_event) instead of whole assistant blocks.
      includePartialMessages: true,
      ...(fullAccess ? {} : { canUseTool: makeCanUseTool(sessionKey) }),
    },
  })

  // The SDK emits system/init (whose session id we persist for resume) only
  // once a first turn runs. With no initial prompt we prime it with a
  // throwaway nudge turn whose events are all suppressed — without that flag
  // the model's answer to the nudge would render as a reply to the user's
  // real first message, which arrives later via `send`.
  const priming = !params.initialPrompt
  const session = {
    q,
    input,
    cwd,
    sessionId: resume ?? '',
    model: params.model ?? '',
    turnActive: true,
    priming,
    pendingTurnStarts: 0,
    streamedText: false,
    streamedThinking: false,
  }
  sessions.set(sessionKey, session)
  void pumpSession(sessionKey, session)

  input.push(userMessage(params.initialPrompt || 'Ready.', session.sessionId))
  if (!priming) emit({ event: 'turn_start', sessionId: sessionKey })

  const deadline = Date.now() + 60_000
  while (!session.sessionId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  if (!session.sessionId) throw new Error('claude session did not initialize within 60s')
  return { sessionKey, session }
}

async function handleRequest(req) {
  const { id, method, params = {} } = req
  try {
    switch (method) {
      case 'list_models': {
        // supportedModels() hangs off a live query, so with no session there is
        // nothing to ask. Returning [] here is what made switching the local
        // agent to claude-code leave the desktop at "No model configured"
        // forever: attach probes the catalog before any session exists, the
        // device catalog is only ever written from a non-empty probe, and
        // claude-code has no provider file to fall back on — so all three tiers
        // stayed empty until something else happened to start a session.
        //
        // Start one instead. It is the same headless session `create_session`
        // builds, minus a prompt: nothing is sent to the model, and it is kept
        // so the next probe (and the first real turn) reuses it.
        let existing = [...sessions.values()][0]
        if (!existing) {
          if (!modelProbeSession) {
            modelProbeSession = startSession({
              cwd: params.cwd || process.cwd(),
              permissionMode: params.permissionMode ?? 'default',
            }).finally(() => {
              modelProbeSession = null
            })
          }
          try {
            existing = (await modelProbeSession).session
          } catch (e) {
            // An unusable backend (missing login, bad binary) must read as
            // "cannot tell", not as "this device has no models" — the caller
            // persists a non-empty catalog and shows a terminal
            // "nothing configured" hint for the latter.
            emit({ id, error: { message: `list_models could not start a session: ${e.message}` } })
            break
          }
        }
        const models = await existing.q.supportedModels()
        emit({
          id,
          result: {
            models: models.map((m) => ({
              id: `claude/${m.value}`,
              displayName: m.displayName ?? m.value,
              providerName: 'claude',
              description: m.description ?? '',
            })),
          },
        })
        break
      }
      case 'create_session':
      case 'resume_session': {
        const resume = method === 'resume_session' ? params.sessionId : undefined
        if (method === 'resume_session' && !resume) throw new Error('sessionId is required')
        const { sessionKey, session } = await startSession(params, resume)
        emit({ id, result: { sessionKey, sessionId: session.sessionId, model: session.model } })
        break
      }
      case 'send': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        if (!params.text) throw new Error('text is required')
        if (params.model && params.model !== session.model) {
          await session.q.setModel(params.model)
          session.model = params.model
        }
        if (session.turnActive) {
          // A turn is still running (possibly the invisible priming turn).
          // Emitting turn_start now would let that turn's result close the
          // new turn before it produced anything; defer to its `result`.
          session.pendingTurnStarts += 1
        } else {
          session.turnActive = true
          emit({ event: 'turn_start', sessionId: params.sessionKey })
        }
        session.input.push(userMessage(params.text, session.sessionId))
        emit({ id, result: { ok: true } })
        break
      }
      case 'cancel': {
        const session = sessions.get(params.sessionKey)
        if (session) await session.q.interrupt()
        emit({ id, result: { ok: true } })
        break
      }
      case 'set_model': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        // A real control-protocol call — takes effect on the next turn.
        await session.q.setModel(params.model || undefined)
        session.model = params.model ?? ''
        emit({ id, result: { model: session.model } })
        break
      }
      case 'get_session_info': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        emit({
          id,
          result: {
            sessionId: session.sessionId,
            cwd: session.cwd,
            // Reported by the SDK (init / result.modelUsage), not our request.
            ...(session.model ? { sdkModel: `claude/${session.model}` } : {}),
          },
        })
        break
      }
      case 'resolve_permission': {
        const pending = pendingPermissions.get(params.requestId)
        if (!pending) {
          emit({ id, result: { ok: false, reason: 'unknown request' } })
          break
        }
        if (params.granted) {
          pending.settle({
            behavior: 'allow',
            updatedInput: pending.input,
            // "Always allow" rides the SDK's own suggestions so the rule it
            // persists matches what the tool call actually needs.
            ...(params.always && Array.isArray(params.suggestions) && params.suggestions.length > 0
              ? { updatedPermissions: params.suggestions }
              : {}),
          })
        } else {
          pending.settle({
            behavior: 'deny',
            message: params.message || 'The user rejected this tool call.',
            interrupt: params.interrupt === true,
          })
        }
        emit({ id, result: { ok: true } })
        break
      }
      case 'close_session': {
        const session = sessions.get(params.sessionKey)
        if (session) {
          session.input.close()
          sessions.delete(params.sessionKey)
        }
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

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let req
    try {
      req = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (req?.method && req?.id != null) void handleRequest(req)
  }
  for (const session of sessions.values()) session.input.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
