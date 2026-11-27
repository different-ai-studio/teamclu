import type { Message, ToolCall } from '@/stores/session-types'
import { getCommandText, getToolCallOutputText } from '@/lib/ui/terminal-interaction'
import { matchesCommandTool } from '@/components/chat/tool-calls/tool-call-utils'

/** An app an agent created in a session, as its `amuxd app create` printed it. */
export interface CreatedApp {
  appId: string
  appName: string
}

const APP_CREATE_COMMAND = /(^|[\s;&|(])amuxd\s+app\s+create\b/

/**
 * The app a finished `amuxd app create` tool call created, or null.
 *
 * Agents create apps by running `amuxd app create` in the bash tool (#2032).
 * The daemon cannot tell which session ran it, so the client is the one place
 * that sees both the session and the result (#1885). The command prints its
 * CLI envelope as one JSON line by default (`-o json`):
 * `{"v":1,"ok":true,"data":{"action":"create","app":{"id":…,"name":…},…}}`.
 * `data.ok` may be false when the checkout failed — the app exists all the
 * same, so only the outer envelope and an app id decide. Other output modes
 * (`-o table`, `-o file:`) are not recognised, and that is fine: nothing is
 * offered rather than something wrong.
 */
export function detectCreatedApp(toolCall: ToolCall): CreatedApp | null {
  if (toolCall.status !== 'completed') return null
  if (!matchesCommandTool(toolCall)) return null
  if (!APP_CREATE_COMMAND.test(getCommandText(toolCall.arguments))) return null
  const output = getToolCallOutputText(toolCall.result, toolCall.arguments)
  // The envelope is one line; anything else the command chain printed is not.
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = createdAppFromEnvelope(lines[i])
    if (found) return found
  }
  return null
}

function createdAppFromEnvelope(line: string): CreatedApp | null {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    return null
  }
  if (!envelope || typeof envelope !== 'object') return null
  const { ok, data } = envelope as { ok?: unknown; data?: unknown }
  if (ok !== true || !data || typeof data !== 'object') return null
  const { action, app } = data as { action?: unknown; app?: unknown }
  if (action !== 'create' || !app || typeof app !== 'object') return null
  const { id, name } = app as { id?: unknown; name?: unknown }
  if (typeof id !== 'string' || !id) return null
  return { appId: id, appName: typeof name === 'string' && name ? name : id }
}

/**
 * The last app created in this message's tool calls. A message carries its
 * tool calls in `parts` (ordered) and, on older paths, in `toolCalls`.
 */
export function detectCreatedAppInMessage(message: Pick<Message, 'parts' | 'toolCalls'>): CreatedApp | null {
  const calls: ToolCall[] = []
  for (const part of message.parts ?? []) {
    if (part.type === 'tool-call' && part.toolCall) calls.push(part.toolCall)
  }
  if (calls.length === 0) calls.push(...(message.toolCalls ?? []))
  for (let i = calls.length - 1; i >= 0; i--) {
    const found = detectCreatedApp(calls[i])
    if (found) return found
  }
  return null
}
