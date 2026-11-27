import i18n from '@/lib/i18n'
import type { AppRow } from '@/lib/backend/types'

/**
 * The message the deploy button sends on the user's behalf.
 *
 * Deploying is the agent's job now, not the desktop's: the agent holds the
 * `deploy-app` skill and `amuxd app deploy`, and those already carry every
 * check the old client-side pipeline did (clean checkout at the remote HEAD,
 * regional runtime facts, artifact verification, the preflight). The click is
 * the user's explicit request to publish, which is what the skill waits for
 * before deploying.
 */
export function deployPromptForApp(app: Pick<AppRow, 'name'>): string {
  const name = app.name.trim()
  return i18n.t(
    'apps.deployPrompt',
    '请把应用「{{name}}」部署上线。\n\n按 deploy-app 技能的流程来：先用 amuxd app status 看清当前状态；有没提交或没推送的改动就先提交并推送；然后运行 amuxd app deploy 发布。部署完成后告诉我线上地址、部署的版本，以及你验证了什么。',
    { name },
  )
}

/**
 * Where the deploy prompt goes: the open session when it already belongs to
 * this app, otherwise the app's most recent session, otherwise a new one.
 */
async function resolveDeploySession(app: AppRow): Promise<string | null> {
  const [{ useSessionSelectionStore }, { useAppsStore }] = await Promise.all([
    import('@/stores/session-selection-store'),
    import('@/stores/apps-store'),
  ])
  const active = useSessionSelectionStore.getState().activeSessionId
  if (active && useAppsStore.getState().appIdBySessionId[active] === app.id) {
    return active
  }
  const { ensureAppSession, createAppSessionShell } = await import('@/lib/apps/app-session')
  return (await ensureAppSession(app)) ?? (await createAppSessionShell(app))
}

/**
 * Ask the app's agent to deploy it: pick (or create) the app's session, bring
 * it to the front, and send the deploy prompt into it.
 *
 * Resolves to the session the prompt went into, or null when it could not be
 * sent (no session could be made, or no signed-in context to send from).
 */
export async function requestAgentDeploy(app: AppRow): Promise<string | null> {
  const sessionId = await resolveDeploySession(app)
  if (!sessionId) return null

  const [{ useAppsStore }, { useUIStore }, { useSessionSelectionStore }] = await Promise.all([
    import('@/stores/apps-store'),
    import('@/stores/ui'),
    import('@/stores/session-selection-store'),
  ])
  useAppsStore.getState().recordAppSession(app.id, sessionId)
  if (useSessionSelectionStore.getState().activeSessionId !== sessionId) {
    await useUIStore.getState().switchToSession(sessionId, { keepSidebarFilter: true })
  }
  // The switch can be overtaken by another click; sending into whatever session
  // is active by then would deploy from the wrong conversation.
  if (useSessionSelectionStore.getState().activeSessionId !== sessionId) return null

  const { sendAgentPromptInActiveSession } = await import('@/lib/session/session-send-agent')
  const messageId = await sendAgentPromptInActiveSession(deployPromptForApp(app))
  return messageId ? sessionId : null
}
