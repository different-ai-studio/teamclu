import type {
  DaemonDomainHostStats,
  DaemonEnvActivationDiagnostics,
  DaemonRuntimeRefresh,
} from '@/lib/daemon/daemon-local-client'
import type { TFunction } from 'i18next'

/** Personal env storage diagnostics from the desktop Tauri command. */
interface PersonalEnvDiagnostics {
  storageDir: string
  secretsDir: string
  masterKeyExists: boolean
  blobExists: boolean
  blobReadable: boolean
  blobError: string | null
  storedVarCount: number
  userStoredVarCount: number
  workspaceIndexCount: number
  indexKeysMissingFromBlob: string[]
  blobKeysMissingFromIndex: string[]
  hostShadowedKeys: string[]
}

type EnvActivationOverallStatus = 'healthy' | 'degraded' | 'blocked'

const CRITICAL_BLOCKER_CODES = new Set([
  'personal_blob_undecryptable',
  'personal_blob_missing',
  'personal_store_uninitialized',
  'refresh_failed',
  'host_env_shadowed',
  'host_capacity_timeout',
  'unresolved_env_keys',
  'team_secret_missing',
  'missing_expected_env_keys',
  'mcp_placeholder_unresolved',
  'env_not_served',
])

/** Roll up desktop + daemon diagnostics into a single headline status. */
export function computeEnvActivationOverallStatus(
  personal: PersonalEnvDiagnostics | null,
  activation: DaemonEnvActivationDiagnostics | null,
  dirtyKeyCount: number,
): EnvActivationOverallStatus {
  if (!personal || !activation) return 'degraded'

  if (
    !personal.blobReadable
    || activation.activation_status === 'blocked'
    || activation.blockers.some((blocker) => CRITICAL_BLOCKER_CODES.has(blocker.code))
    || dirtyKeyCount > 0
  ) {
    return 'blocked'
  }

  const reloadPending = (activation.refresh.status === 'pending' || activation.refresh.status === 'applying')
    && activation.refresh.change_kinds.includes('env_vars')

  // Index vs blob drift is degraded only: personal values are machine-global
  // (encrypted blob). Workspace envVars is a derived cache, not an allowlist.
  const indexDrift = personal.indexKeysMissingFromBlob.length > 0
    || personal.blobKeysMissingFromIndex.length > 0

  if (
    activation.activation_status !== 'active'
    || activation.blockers.length > 0
    || activation.unresolved_env_keys.length > 0
    || activation.alias_collision_keys.length > 0
    || activation.override_keys.length > 0
    || activation.active_runtime_count > 0
    || personal.hostShadowedKeys.length > 0
    || activation.host_env_shadowed_keys.length > 0
    || activation.missing_served_env_keys.length > 0
    || activation.refresh.status !== 'clean'
    || reloadPending
    || indexDrift
  ) {
    return 'degraded'
  }

  return 'healthy'
}

/** Map a daemon per-key status code to a short settings-row label. */
export function formatEnvKeyActivationStatus(
  t: TFunction,
  status: string | undefined,
): string | null {
  if (!status) return null
  switch (status) {
    case 'active':
      return t('settings.envVars.injection.active', 'Injected')
    case 'pending':
      return t('settings.envVars.injection.pending', 'Pending reload')
    case 'pending_session':
      return t('settings.envVars.injection.pendingSession', 'Reload + new session')
    case 'overridden':
      return t('settings.envVars.injection.overridden', 'Overridden')
    case 'unresolved':
      return t('settings.envVars.injection.unresolved', 'Unresolved')
    case 'host_shadowed':
      return t('settings.envVars.injection.hostShadowed', 'Host shadowed')
    case 'missing':
      return t('settings.envVars.injection.missing', 'Missing')
    case 'not_served':
      return t('settings.envVars.injection.notServed', 'Not in serve host')
    default:
      return status
  }
}

const EMPTY_REFRESH: DaemonRuntimeRefresh = {
  status: 'clean',
  change_kinds: [],
  recommended_action: 'none',
  auto_apply_blocked_by_active_runtime: false,
  last_detected_at: null,
  last_error: null,
}

const EMPTY_HOST_POOL: DaemonDomainHostStats = {
  current_generation: null,
  current_lifecycle: null,
  pending_lifecycle: null,
  current_revision: null,
  requested_revision: null,
  current_routes: 0,
  draining_generations: 0,
  draining_routes: 0,
  idle_age: null,
  queued_acquisitions: 0,
  last_error: null,
}

interface EnvActivationBlocker {
  code: string
  detail?: string | null
}

/** Translate daemon blocker codes for the settings diagnostics UI. */
export function formatEnvActivationBlocker(
  t: TFunction,
  blocker: EnvActivationBlocker,
): string {
  const detail = blocker.detail?.trim()
  const detailSuffix = detail ? `: ${detail}` : ''
  switch (blocker.code) {
    case 'personal_blob_undecryptable':
      return t('settings.envVars.diag.blockerPersonalBlobUndecryptable', {
        detail: detailSuffix,
        defaultValue: `Personal secrets blob exists but cannot be decrypted${detailSuffix}`,
      })
    case 'personal_blob_missing':
      return t('settings.envVars.diag.blockerPersonalBlobMissing', 'Master key exists but the encrypted blob is missing')
    case 'personal_store_uninitialized':
      return t('settings.envVars.diag.blockerPersonalStoreUninitialized', 'Personal secrets store is not initialized on this machine')
    case 'refresh_failed':
      return t('settings.envVars.diag.blockerRefreshFailed', {
        detail: detailSuffix,
        defaultValue: `Runtime refresh failed${detailSuffix}`,
      })
    case 'env_vars_pending':
      return t('settings.envVars.diag.blockerEnvVarsPending', 'Env var changes are pending — reload the workspace runtime')
    case 'refresh_deferred_active_turn':
      return t('settings.envVars.diag.blockerRefreshDeferredActiveTurn', 'Refresh deferred while a turn is in progress — retry after it finishes or reload manually')
    case 'active_runtimes':
      return t('settings.envVars.diag.blockerActiveRuntimes', {
        count: detail ?? '?',
        defaultValue: `${detail ?? '?'} active runtime(s) in this workspace — env is injected at spawn; start a new session after reload`,
      })
    case 'turn_in_progress':
      return t('settings.envVars.diag.blockerTurnInProgress', 'A turn is currently running — wait for it to finish, then reload runtime')
    case 'opencode_serve_no_cached_env':
      return t('settings.envVars.diag.blockerOpencodeServeNoCachedEnv', 'opencode serve is running but has no cached session env — reload runtime so the next spawn merges personal vars')
    case 'host_env_shadowed':
      return t('settings.envVars.diag.blockerHostEnvShadowed', {
        keys: detail ?? '',
        defaultValue: `Host OS environment overrides personal vars for: ${detail ?? ''}`,
      })
    case 'host_generation_starting':
      return t('settings.envVars.diag.blockerHostGenerationStarting', {
        detail: detailSuffix,
        defaultValue: `Workspace runtime generation is starting${detailSuffix}`,
      })
    case 'host_capacity_waiting':
      return t('settings.envVars.diag.blockerHostCapacityWaiting', {
        detail: detailSuffix,
        defaultValue: `New sessions are waiting for local runtime capacity${detailSuffix}`,
      })
    case 'host_capacity_timeout':
      return t('settings.envVars.diag.blockerHostCapacityTimeout', {
        detail: detailSuffix,
        defaultValue: `Timed out waiting for local runtime capacity${detailSuffix}`,
      })
    case 'unresolved_env_keys':
      return t('settings.envVars.diag.blockerUnresolvedEnvKeys', {
        keys: detail ?? '',
        defaultValue: `Variables could not be resolved for runtime injection: ${detail ?? ''}`,
      })
    case 'env_snapshot_pending':
      return t('settings.envVars.diag.blockerEnvSnapshotPending', 'Resolved environment is not yet active in this workspace runtime generation')
    case 'alias_collision':
      return t('settings.envVars.diag.blockerAliasCollision', {
        keys: detail ?? '',
        defaultValue: `Alias keys collide with explicitly configured keys: ${detail ?? ''}`,
      })
    case 'env_layer_override':
      return t('settings.envVars.diag.blockerEnvLayerOverride', {
        keys: detail ?? '',
        defaultValue: `Higher-priority layers override earlier values for: ${detail ?? ''}`,
      })
    case 'team_secret_missing':
      return t('settings.envVars.diag.blockerTeamSecretMissing', 'Team encrypted env files exist but no team secret is configured on this machine')
    case 'missing_expected_env_keys':
      return t('settings.envVars.diag.blockerMissingExpectedEnvKeys', {
        keys: detail ?? '',
        defaultValue: `Expected env keys are missing from the resolved snapshot: ${detail ?? ''}`,
      })
    case 'mcp_placeholder_unresolved':
      return t('settings.envVars.diag.blockerMcpPlaceholderUnresolved', {
        keys: detail ?? '',
        defaultValue: `opencode.json still references unresolved placeholders: ${detail ?? ''}`,
      })
    case 'env_not_served':
      return t('settings.envVars.diag.blockerEnvNotServed', {
        keys: detail ?? '',
        defaultValue: `Resolved keys are missing from the OpenCode serve host queue: ${detail ?? ''}`,
      })
    default:
      if (blocker.code === 'legacy_message' && detail) return detail
      return detail ? `${blocker.code}: ${detail}` : blocker.code
  }
}

function normalizeBlocker(raw: Partial<EnvActivationBlocker>): EnvActivationBlocker {
  return {
    code: raw.code ?? 'unknown',
    detail: raw.detail ?? null,
  }
}

function normalizeHostPool(raw: unknown): DaemonDomainHostStats {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_HOST_POOL }
  const wire = raw as Partial<DaemonDomainHostStats> & {
    currentGeneration?: string | null
    currentLifecycle?: string | null
    pendingLifecycle?: string | null
    currentRevision?: string | null
    requestedRevision?: string | null
    currentRoutes?: number
    drainingGenerations?: number
    drainingRoutes?: number
    idleAge?: DaemonDomainHostStats['idle_age']
    queuedAcquisitions?: number
    lastError?: string | null
  }
  return {
    current_generation: wire.current_generation ?? wire.currentGeneration ?? null,
    current_lifecycle: wire.current_lifecycle ?? wire.currentLifecycle ?? null,
    pending_lifecycle: wire.pending_lifecycle ?? wire.pendingLifecycle ?? null,
    current_revision: wire.current_revision ?? wire.currentRevision ?? null,
    requested_revision: wire.requested_revision ?? wire.requestedRevision ?? null,
    current_routes: wire.current_routes ?? wire.currentRoutes ?? 0,
    draining_generations: wire.draining_generations ?? wire.drainingGenerations ?? 0,
    draining_routes: wire.draining_routes ?? wire.drainingRoutes ?? 0,
    idle_age: wire.idle_age ?? wire.idleAge ?? null,
    queued_acquisitions: wire.queued_acquisitions ?? wire.queuedAcquisitions ?? 0,
    last_error: wire.last_error ?? wire.lastError ?? null,
  }
}

/** Coerce partial / older daemon responses so UI never crashes on missing fields. */
export function normalizeDaemonEnvActivationDiagnostics(
  raw: Partial<DaemonEnvActivationDiagnostics> | null | undefined,
): DaemonEnvActivationDiagnostics | null {
  if (!raw) return null
  const wire = raw as Partial<DaemonEnvActivationDiagnostics> & {
    personalEnvVarCount?: number
    personalBlobUserVarCount?: number
    personalBlobReadable?: boolean
    personalLoadError?: string | null
    teamEnvVarCount?: number
    systemEnvVarCount?: number
    opencodeServeRunning?: boolean
    opencodeServeCachedEnvCount?: number
    activeRuntimeCount?: number
    workspaceHasActiveTurn?: boolean
    hostEnvShadowedKeys?: string[]
    resolvedEnvFingerprint?: string | null
    activeEnvFingerprint?: string | null
    overrideKeys?: string[]
    aliasCollisionKeys?: string[]
    unresolvedEnvKeys?: string[]
    snapshotConflictWorkspace?: string | null
    activationStatus?: 'active' | 'pending' | 'blocked'
    expectedEnvKeys?: string[]
    effectiveEnvKeys?: string[]
    missingExpectedKeys?: string[]
    keyStatuses?: DaemonEnvActivationDiagnostics['key_statuses']
    mcpUnresolvedPlaceholders?: DaemonEnvActivationDiagnostics['mcp_unresolved_placeholders']
    installedEnvFingerprint?: string | null
    activeHandleEnvFingerprint?: string | null
    teamSecretConfigured?: boolean
    opencodeServeCachedEnvKeys?: string[]
    missingServedEnvKeys?: string[]
    activeHandleEnvKeys?: string[]
    hostPool?: unknown
  }

  const blockers = (wire.blockers ?? []).map((entry) => {
    if (typeof entry === 'string') {
      return { code: 'legacy_message', detail: entry }
    }
    return normalizeBlocker(entry)
  })
  const hostPool = normalizeHostPool(wire.host_pool ?? wire.hostPool)
  const hasBlocker = (code: string) => blockers.some((blocker) => blocker.code === code)
  if (
    hostPool.pending_lifecycle?.toLowerCase() === 'starting'
    && !hasBlocker('host_generation_starting')
  ) {
    blockers.push({
      code: 'host_generation_starting',
      detail: hostPool.requested_revision ? `revision ${hostPool.requested_revision}` : null,
    })
  }
  if (hostPool.queued_acquisitions > 0 && !hasBlocker('host_capacity_waiting')) {
    blockers.push({
      code: 'host_capacity_waiting',
      detail: `${hostPool.queued_acquisitions} queued acquisition(s)`,
    })
  }
  if (
    hostPool.last_error
    && /capacity.*(?:timed out|timeout|exhaust(?:ed|ion)?)/i.test(hostPool.last_error)
    && !hasBlocker('host_capacity_timeout')
  ) {
    blockers.push({
      code: 'host_capacity_timeout',
      detail: hostPool.last_error,
    })
  }

  return {
    personal_env_var_count: wire.personal_env_var_count ?? wire.personalEnvVarCount ?? wire.personal_blob_user_var_count ?? wire.personalBlobUserVarCount ?? 0,
    personal_blob_user_var_count: wire.personal_blob_user_var_count ?? wire.personalBlobUserVarCount ?? wire.personal_env_var_count ?? wire.personalEnvVarCount ?? 0,
    personal_blob_readable: wire.personal_blob_readable ?? wire.personalBlobReadable ?? false,
    personal_load_error: wire.personal_load_error ?? wire.personalLoadError ?? null,
    team_env_var_count: wire.team_env_var_count ?? wire.teamEnvVarCount ?? 0,
    system_env_var_count: wire.system_env_var_count ?? wire.systemEnvVarCount ?? 0,
    opencode_serve_running: wire.opencode_serve_running ?? wire.opencodeServeRunning ?? false,
    opencode_serve_cached_env_count: wire.opencode_serve_cached_env_count ?? wire.opencodeServeCachedEnvCount ?? 0,
    active_runtime_count: wire.active_runtime_count ?? wire.activeRuntimeCount ?? 0,
    workspace_has_active_turn: wire.workspace_has_active_turn ?? wire.workspaceHasActiveTurn ?? false,
    refresh: {
      ...EMPTY_REFRESH,
      ...wire.refresh,
      change_kinds: wire.refresh?.change_kinds ?? [],
    },
    host_pool: hostPool,
    host_env_shadowed_keys: wire.host_env_shadowed_keys ?? wire.hostEnvShadowedKeys ?? [],
    resolved_env_fingerprint: wire.resolved_env_fingerprint ?? wire.resolvedEnvFingerprint ?? null,
    active_env_fingerprint: wire.active_env_fingerprint ?? wire.activeEnvFingerprint ?? null,
    override_keys: wire.override_keys ?? wire.overrideKeys ?? [],
    alias_collision_keys: wire.alias_collision_keys ?? wire.aliasCollisionKeys ?? [],
    unresolved_env_keys: wire.unresolved_env_keys ?? wire.unresolvedEnvKeys ?? [],
    snapshot_conflict_workspace: wire.snapshot_conflict_workspace ?? wire.snapshotConflictWorkspace ?? null,
    activation_status: wire.activation_status ?? wire.activationStatus ?? 'pending',
    blockers,
    expected_env_keys: wire.expected_env_keys ?? wire.expectedEnvKeys ?? [],
    effective_env_keys: wire.effective_env_keys ?? wire.effectiveEnvKeys ?? [],
    missing_expected_keys: wire.missing_expected_keys ?? wire.missingExpectedKeys ?? [],
    key_statuses: wire.key_statuses ?? wire.keyStatuses ?? [],
    mcp_unresolved_placeholders: wire.mcp_unresolved_placeholders ?? wire.mcpUnresolvedPlaceholders ?? [],
    installed_env_fingerprint: wire.installed_env_fingerprint ?? wire.installedEnvFingerprint ?? null,
    active_handle_env_fingerprint: wire.active_handle_env_fingerprint ?? wire.activeHandleEnvFingerprint ?? null,
    team_secret_configured: wire.team_secret_configured ?? wire.teamSecretConfigured ?? false,
    opencode_serve_cached_env_keys: wire.opencode_serve_cached_env_keys ?? wire.opencodeServeCachedEnvKeys ?? [],
    missing_served_env_keys: wire.missing_served_env_keys ?? wire.missingServedEnvKeys ?? [],
    active_handle_env_keys: wire.active_handle_env_keys ?? wire.activeHandleEnvKeys ?? [],
  }
}

/** Coerce partial / older desktop responses so UI never crashes on missing fields. */
export function normalizePersonalEnvDiagnostics(
  raw: Partial<PersonalEnvDiagnostics> | null | undefined,
): PersonalEnvDiagnostics | null {
  if (!raw) return null
  return {
    storageDir: raw.storageDir ?? '',
    secretsDir: raw.secretsDir ?? '',
    masterKeyExists: raw.masterKeyExists ?? false,
    blobExists: raw.blobExists ?? false,
    blobReadable: raw.blobReadable ?? false,
    blobError: raw.blobError ?? null,
    storedVarCount: raw.storedVarCount ?? 0,
    userStoredVarCount: raw.userStoredVarCount ?? raw.storedVarCount ?? 0,
    workspaceIndexCount: raw.workspaceIndexCount ?? 0,
    indexKeysMissingFromBlob: raw.indexKeysMissingFromBlob ?? [],
    blobKeysMissingFromIndex: raw.blobKeysMissingFromIndex ?? [],
    hostShadowedKeys: raw.hostShadowedKeys ?? [],
  }
}
