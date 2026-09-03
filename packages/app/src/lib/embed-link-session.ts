import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { emitPageLinkInsert } from '@/lib/embed-composer-bus'
import type { PageContext } from '@/lib/embed-page-context'
import { isPendingLinkOpenPayload, linkSessionTitle, lookupLinkSessionEntry, PENDING_LINK_OPEN_KEY, upsertLinkSessionEntry } from '@/lib/extension-link-session'
import { resolveQuickChatTarget, type QuickChatTarget } from '@/lib/resolve-quick-chat-target'
import { createSessionShell } from '@/lib/session-create'
import { ensureSessionLiveSubscribed } from '@/lib/session-live-subscriptions'
import { getBackend } from '@/lib/backend'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useEngagedAgentStore } from '@/stores/engaged-agent-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session-store'
import { useUIStore } from '@/stores/ui'

export { isPendingLinkOpenPayload, PENDING_LINK_OPEN_KEY }
export type { PendingLinkOpen } from '@/lib/extension-link-session'

type ChromeSessionStorage = {
  get: (key: string) => Promise<Record<string, unknown>>
  remove: (key: string) => Promise<void>
  onChanged?: {
    addListener: (h: (changes: Record<string, { newValue?: unknown }>) => void) => void
    removeListener: (h: (changes: Record<string, { newValue?: unknown }>) => void) => void
  }
}

function readChromeSession(): ChromeSessionStorage | undefined {
  return (globalThis as { chrome?: { storage?: { session?: ChromeSessionStorage } } }).chrome?.storage
    ?.session
}

const EMBED_READY_TIMEOUT_MS = 15_000
const EMBED_READY_POLL_MS = 120

async function waitForEmbedReady(timeoutMs = EMBED_READY_TIMEOUT_MS): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const auth = useAuthStore.getState().session
    const teamId = useCurrentTeamStore.getState().team?.id
    if (auth?.user?.id && teamId) return true
    await new Promise((resolve) => setTimeout(resolve, EMBED_READY_POLL_MS))
  }
  console.warn('[embed-link-session] timed out waiting for auth/team readiness')
  return false
}

async function createExtensionLinkSession(input: {
  teamId: string
  title: string
  agent: QuickChatTarget | null
}): Promise<{ sessionId: string } | null> {
  const authUserId = useAuthStore.getState().session?.user?.id ?? null
  const currentMemberId = useCurrentTeamStore.getState().currentMember?.id ?? null
  if (!authUserId) return null

  const creatorActorId = await resolveCurrentMemberActorId(input.teamId, authUserId, {
    currentTeamId: input.teamId,
    currentMemberId,
  })
  if (!creatorActorId) return null

  const agentId = input.agent?.agentId ?? null
  const { sessionId } = await createSessionShell({
    teamId: input.teamId,
    creatorActorId,
    title: input.title,
    additionalActorIds: agentId ? [agentId] : [],
  })

  await ensureSessionLiveSubscribed(input.teamId, sessionId).catch((e) => {
    console.warn('[embed-link-session] live subscribe failed (non-fatal):', e)
  })

  if (input.agent) {
    useEngagedAgentStore.getState().setAgents(sessionId, [
      { id: input.agent.agentId, displayName: input.agent.displayName },
    ])
    void import('@/lib/teamclu/ensure-agent-runtime').then(({ ensureAgentRuntimesForSession }) => {
      void ensureAgentRuntimesForSession({
        sessionId,
        teamId: input.teamId,
        agentActorIds: [input.agent!.agentId],
        reason: 'extension_link_hover',
      })
    })
  }

  await useSessionListStore.getState().load()
  useSessionStore.getState().addHighlightedSession(sessionId)
  await useUIStore.getState().switchToSession(sessionId)
  useUIStore.getState().requestComposerFocus()

  return { sessionId }
}

async function resolveLinkSession(input: {
  page: PageContext
  linkKey: string
}): Promise<{ sessionId: string; created: boolean } | null> {
  const teamId = useCurrentTeamStore.getState().team?.id
  if (!teamId) return null

  const existing = await lookupLinkSessionEntry(teamId, input.linkKey)
  if (existing) {
    try {
      const row = await getBackend().sessions.getSession(existing.sessionId, teamId)
      if (row) {
        // Product: reopening an existing link session does not re-inject the page pill.
        await useUIStore.getState().switchToSession(existing.sessionId)
        await upsertLinkSessionEntry({
          teamId,
          linkKey: input.linkKey,
          sessionId: existing.sessionId,
          linkText: existing.linkText,
          createdAt: existing.createdAt,
          lastOpenedAt: Date.now(),
        })
        return { sessionId: existing.sessionId, created: false }
      }
    } catch (e) {
      console.warn('[embed-link-session] getSession failed; opening mapped session without remap', e)
      await useUIStore.getState().switchToSession(existing.sessionId)
      return { sessionId: existing.sessionId, created: false }
    }
  }

  const target = await resolveQuickChatTarget(teamId, { workspacePath: null })
  const linkText = input.page.selection.trim() || input.page.text.trim() || input.page.url
  const created = await createExtensionLinkSession({
    teamId,
    title: linkSessionTitle(linkText),
    agent: target,
  })
  if (!created) return null

  await upsertLinkSessionEntry({
    teamId,
    linkKey: input.linkKey,
    sessionId: created.sessionId,
    linkText,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  })
  emitPageLinkInsert(input.page)
  return { sessionId: created.sessionId, created: true }
}

let consumeInFlight: Promise<void> | null = null

async function consumePendingLinkOpen(): Promise<void> {
  if (consumeInFlight) return consumeInFlight

  consumeInFlight = (async () => {
    const storage = readChromeSession()
    if (!storage) return

    try {
      const bag = await storage.get(PENDING_LINK_OPEN_KEY)
      const payload = bag[PENDING_LINK_OPEN_KEY]
      if (!isPendingLinkOpenPayload(payload)) return

      const ready = await waitForEmbedReady()
      if (!ready) return

      const result = await resolveLinkSession({ page: payload.page, linkKey: payload.linkKey })
      if (result) {
        await storage.remove(PENDING_LINK_OPEN_KEY)
      }
    } catch (e) {
      console.warn('[embed-link-session] consume pending failed', e)
    }
  })().finally(() => {
    consumeInFlight = null
  })

  return consumeInFlight
}

const PENDING_LINK_CONSUME_RETRY_MS = 120
const PENDING_LINK_CONSUME_RETRY_WINDOW_MS = 3_000

export function startEmbedLinkOpenListener(): () => void {
  const storage = readChromeSession()
  const onSessionChanged = (changes: Record<string, { newValue?: unknown }>) => {
    if (changes[PENDING_LINK_OPEN_KEY]?.newValue) {
      void consumePendingLinkOpen()
    }
  }

  void consumePendingLinkOpen()

  const retryUntil = Date.now() + PENDING_LINK_CONSUME_RETRY_WINDOW_MS
  const retryTimer = window.setInterval(() => {
    if (Date.now() > retryUntil) {
      window.clearInterval(retryTimer)
      return
    }
    void consumePendingLinkOpen()
  }, PENDING_LINK_CONSUME_RETRY_MS)

  const stopRetry = () => window.clearInterval(retryTimer)

  if (!storage?.onChanged) {
    return stopRetry
  }

  storage.onChanged.addListener(onSessionChanged)
  return () => {
    stopRetry()
    storage.onChanged?.removeListener(onSessionChanged)
  }
}

