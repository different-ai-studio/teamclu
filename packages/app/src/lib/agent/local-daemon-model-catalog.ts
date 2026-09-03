import { create } from '@bufbuild/protobuf'
import { ModelInfoSchema, RuntimeInfoSchema, type ModelInfo } from '@/lib/proto/amux_pb'
import {
  encodeWorkspaceId,
  getDaemonModelCatalog,
  type DaemonBackendCatalog,
  type DaemonModelCatalog,
} from '@/lib/daemon/daemon-local-client'
import {
  attachmentKey,
  useRuntimeStateStore,
} from '@/stores/runtime-state-store'
import { sessionFlowLog } from '@/lib/session/session-flow-log'

/**
 * Model catalog for the **local** daemon over loopback HTTP, bypassing MQTT.
 *
 * # Why this exists
 *
 * `RuntimeInfo.available_models` reaches the client on the retained actor
 * `{actor}/state` snapshot (or loopback HTTP below). `RuntimeStartResult`
 * carries no models and `GET /v1/live/events` does not tee runtime state. The
 * session pill needs a non-empty catalog to leave `connecting` (see
 * `resolveSessionAgentUiState`), so on a slow broker a brand-new session sat at
 * 连接中 for the full `SESSION_AGENT_CONNECTING_TIMEOUT_MS` and then reported
 * offline, even with a perfectly healthy local daemon one loopback hop away.
 *
 * `GET /v1/workspaces/:id/model-catalog` answers the same question directly, and
 * its handler brings the backend up on demand, so it works with zero sessions
 * created. All four implemented backends (opencode / pi / cursor / claude-code)
 * resolve through it, each falling back to this device's persisted catalog when
 * a live probe comes back empty.
 *
 * This is a *supplement*, not a replacement: the MQTT retain remains the source
 * of truth and overwrites whatever we seed here as soon as it lands. Remote
 * agents are unaffected — loopback HTTP only reaches this device's daemon.
 */

/** Backend id (`ModelCatalog.backends[].backend`) for a client backend type. */
function catalogBackendId(backendType: string | null | undefined): string | null {
  switch (backendType) {
    case 'opencode':
      return 'opencode'
    case 'pi':
      return 'pi'
    case 'cursor':
      return 'cursor'
    // The group id is the daemon's *wire* name for the type
    // (`runtime_resolution::agent_type_name`), which is "claude-code" — not the
    // `AgentLaunchConfig.backend_type` spelling ("claude"). Both are accepted
    // server-side, so match on the wire name here.
    case 'claude-code':
    case 'claude':
    case 'claude_code':
      return 'claude-code'
    default:
      return null
  }
}

/**
 * What the loopback catalog says about this device, as three *distinct*
 * answers.
 *
 * Collapsing "the daemon never answered" and "the daemon answered, and it has
 * nothing" into one `null` is what made a fresh install indistinguishable from
 * a slow one: both looked like "not yet", so the pill sat at 连接中 until the
 * timeout and then claimed offline — for a daemon that was up the whole time
 * and simply had no provider configured. `empty` is a *terminal* answer and
 * callers are expected to surface it as "needs configuring", not "wait".
 */
type LocalDaemonCatalogOutcome =
  | { status: 'models'; backend: string; models: ModelInfo[] }
  /** The daemon answered and serves no models for this backend. First install. */
  | { status: 'empty'; backend: string }
  /**
   * The daemon answered, and said it could not ask the backend — a rejected
   * cursor API key, a binary that will not start. Distinct from `empty` on
   * purpose: that one is a setup gap the user can act on, this one is a
   * failure, and showing "nothing configured" for it sends them looking for
   * the wrong thing.
   */
  | { status: 'error'; backend: string; message: string }
  /** No answer, or an ambiguous multi-group reply — claim nothing. */
  | { status: 'unknown' }

/**
 * Resolve the backend group this device's catalog is about.
 *
 * Single-agent mode: the daemon serves exactly one group. Prefer the one
 * matching `backendType` when the caller has an opinion, then the daemon's own
 * automation default, then the sole group — mismatching on a stale client-side
 * backend name would mean discarding the only catalog on offer.
 *
 * Returns `null` when several groups are offered and none matches: that is
 * ambiguity, not emptiness, and must not be reported as "nothing configured".
 */
function resolveCatalogGroup(
  catalog: DaemonModelCatalog,
  backendType: string | null | undefined,
): DaemonBackendCatalog | null {
  const soleGroup = catalog.backends.length === 1 ? catalog.backends[0] : null

  const wanted = catalogBackendId(backendType)
  if (wanted) {
    // The caller named a backend and expects models for *that* one. Accept the
    // sole group when the name misses — a stale client-side backend name must
    // not throw away the only catalog on offer — but never pick among several.
    return catalog.backends.find((b) => b.backend === wanted) ?? soleGroup
  }

  // No opinion from the caller ("just tell me what this device runs"): the
  // daemon's own automation default is that answer.
  const automationDefault = catalog.automation_default_backend?.trim()
  const byDefault = automationDefault
    ? catalog.backends.find((b) => b.backend === automationDefault)
    : undefined
  return byDefault ?? soleGroup
}

/**
 * Fetch the local daemon's catalog for `workspacePath`, keeping "unreachable"
 * and "genuinely empty" apart. `backendType` is optional — omit it to take the
 * daemon's own default group, which is what a caller that just wants "this
 * device's models" should do.
 */
export async function fetchLocalDaemonCatalog(
  workspacePath: string,
  backendType?: string | null,
): Promise<LocalDaemonCatalogOutcome> {
  const path = workspacePath.trim()
  if (!path) return { status: 'unknown' }

  const catalog = await getDaemonModelCatalog(encodeWorkspaceId(path))
  if (!catalog) return { status: 'unknown' }

  const group = resolveCatalogGroup(catalog, backendType)
  if (!group) {
    // No group *and* a probe error is the shape a missing runtime binary takes:
    // the daemon could not start the backend this team asked for, so it has no
    // group to report — only the reason. Reading `probe_error` solely inside
    // the group branch below discarded exactly the case where it is the entire
    // answer, and the caller saw `unknown`, which the pill renders as a
    // permanent "connecting…" rather than the terminal error it is.
    const probeError = catalog.probe_error?.trim()
    if (probeError) {
      return {
        status: 'error',
        // The daemon named no backend group, so the best available id is the
        // automation default it wanted to use. Empty is honest when even that
        // is unset — the message carries the detail.
        backend: catalog.automation_default_backend?.trim() ?? '',
        message: probeError,
      }
    }
    return { status: 'unknown' }
  }
  if (group.models.length === 0) {
    const probeError = catalog.probe_error?.trim()
    return probeError
      ? { status: 'error', backend: group.backend, message: probeError }
      : { status: 'empty', backend: group.backend }
  }

  return {
    status: 'models',
    backend: group.backend,
    models: group.models.map((m) =>
      create(ModelInfoSchema, {
        id: m.ref,
        displayName: m.display_name || m.ref,
        // `BackendCatalog.backend` describes the runner (Pi, Cursor, etc.),
        // not the model provider. Grouping every Pi model under "pi" loses
        // the provider hierarchy that Pi already supplies in its stable
        // `<provider>/<model>` reference.
        providerName: m.ref.split('/', 1)[0] || group.backend,
      }),
    ),
  }
}

/**
 * Merge an HTTP-sourced catalog into the runtime-state entry for `runtimeId`.
 *
 * No-op when the entry already advertises models — a retain that already landed
 * is fresher than anything we could add, and `available_models` is what every
 * readiness check keys on.
 */
export function mergeLocalDaemonModels(args: {
  daemonActorId: string
  runtimeId: string
  sessionId?: string | null
  models: ModelInfo[]
}): boolean {
  const daemonActorId = args.daemonActorId.trim()
  const runtimeId = args.runtimeId.trim()
  if (!daemonActorId || !runtimeId || args.models.length === 0) return false

  const store = useRuntimeStateStore.getState()
  const sessionId = args.sessionId?.trim() ?? ''
  const entry =
    (sessionId
      ? store.byRuntimeId[attachmentKey(daemonActorId, sessionId)]
      : undefined) ?? store.byRuntimeId[runtimeId]
  if (!entry) return false
  if (entry.info.availableModels.length > 0) return false

  const info = create(RuntimeInfoSchema, {
    ...entry.info,
    availableModels: args.models,
    // Same rule the daemon applies to its own MRU (`model_mru::first_available`):
    // a remembered model the catalog no longer offers falls through rather than
    // being shown as current.
    // No MRU seed any more: the daemon stopped serving one (ADR-0007) and the
    // client's own history is applied by `selectAgentModel`, which knows the
    // backend and team this list is keyed by. Seeding here could only guess.
    currentModel: entry.info.currentModel?.trim() || '',
  })
  store.upsert(
    sessionId ? attachmentKey(daemonActorId, sessionId) : runtimeId,
    entry.daemonActorId,
    info,
  )
  return true
}

/**
 * Fire-and-forget: resolve the local daemon's catalog over HTTP and merge it in.
 *
 * Deliberately not awaited by the caller. The handler may have to bring a
 * backend process up (pi/cursor spawn a child, opencode runs `serve.ensure()`),
 * so blocking session start on it would trade one stall for another.
 */
export function seedLocalDaemonModelsInBackground(args: {
  daemonActorId: string
  runtimeId: string
  workspacePath: string
  backendType: string | null | undefined
  sessionId?: string
}): void {
  void (async () => {
    try {
      const outcome = await fetchLocalDaemonCatalog(args.workspacePath, args.backendType)
      if (outcome.status !== 'models') return
      const { models } = outcome
      const merged = mergeLocalDaemonModels({
        daemonActorId: args.daemonActorId,
        runtimeId: args.runtimeId,
        sessionId: args.sessionId,
        models,
      })
      sessionFlowLog('runtime_start.http_catalog.seeded', {
        sessionId: args.sessionId,
        agentActorId: args.daemonActorId,
        runtimeId: args.runtimeId,
        backendType: args.backendType ?? null,
        modelCount: models.length,
        // false = an MQTT retain with models beat us to it, which is fine.
        merged,
      })
    } catch (error) {
      // A cache warm-up must never break session start.
      console.warn('[local-daemon-model-catalog] seed failed', error)
    }
  })()
}
