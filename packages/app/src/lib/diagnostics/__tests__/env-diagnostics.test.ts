import { describe, expect, it } from 'vitest'
import {
  computeEnvActivationOverallStatus,
  formatEnvActivationBlocker,
  normalizeDaemonEnvActivationDiagnostics,
  normalizePersonalEnvDiagnostics,
} from '@/lib/diagnostics/env-diagnostics'
import type { DaemonEnvActivationDiagnostics } from '@/lib/daemon/daemon-local-client'

const basePersonal = {
  storageDir: '',
  secretsDir: '',
  masterKeyExists: true,
  blobExists: true,
  blobReadable: true,
  blobError: null,
  storedVarCount: 1,
  userStoredVarCount: 1,
  workspaceIndexCount: 1,
  indexKeysMissingFromBlob: [] as string[],
  blobKeysMissingFromIndex: [] as string[],
  hostShadowedKeys: [] as string[],
}

const baseActivation: DaemonEnvActivationDiagnostics = {
  personal_env_var_count: 1,
  personal_blob_user_var_count: 1,
  personal_blob_readable: true,
  personal_load_error: null,
  team_env_var_count: 0,
  system_env_var_count: 1,
  opencode_serve_running: true,
  opencode_serve_cached_env_count: 3,
  active_runtime_count: 0,
  workspace_has_active_turn: false,
  refresh: {
    status: 'clean',
    change_kinds: [],
    recommended_action: 'none',
    auto_apply_blocked_by_active_runtime: false,
    last_detected_at: null,
    last_error: null,
  },
  host_pool: {
    current_generation: 'gen-1',
    current_lifecycle: 'ready',
    pending_lifecycle: null,
    current_revision: 'rev-1',
    requested_revision: 'rev-1',
    current_routes: 0,
    draining_generations: 0,
    draining_routes: 0,
    idle_age: null,
    queued_acquisitions: 0,
    last_error: null,
  },
  host_env_shadowed_keys: [],
  resolved_env_fingerprint: 'abc',
  active_env_fingerprint: 'abc',
  override_keys: [],
  alias_collision_keys: [],
  unresolved_env_keys: [],
  snapshot_conflict_workspace: null,
  activation_status: 'active',
  blockers: [],
  expected_env_keys: ['openai_api_key'],
  effective_env_keys: ['openai_api_key'],
  missing_expected_keys: [],
  key_statuses: [{ key: 'openai_api_key', scope: 'personal', status: 'active' }],
  mcp_unresolved_placeholders: [],
  installed_env_fingerprint: 'abc',
  active_handle_env_fingerprint: 'abc',
  team_secret_configured: true,
  opencode_serve_cached_env_keys: ['openai_api_key'],
  missing_served_env_keys: [],
  active_handle_env_keys: ['openai_api_key'],
}

const t = ((key: string, options?: string | Record<string, unknown>) => {
  if (typeof options === 'string') return options
  return String(options?.defaultValue ?? key)
}) as Parameters<typeof formatEnvActivationBlocker>[0]

describe('formatEnvActivationBlocker', () => {
  it('describes a queued host acquisition with its queue position', () => {
    const message = formatEnvActivationBlocker(t, {
      code: 'host_capacity_waiting',
      detail: '4 active · position 2',
    })

    expect(message).toContain('New sessions are waiting for local runtime capacity')
    expect(message).toContain('position 2')
  })

  it('describes a host capacity timeout with its active count', () => {
    const message = formatEnvActivationBlocker(t, {
      code: 'host_capacity_timeout',
      detail: '6 active',
    })

    expect(message).toContain('Timed out waiting for local runtime capacity')
    expect(message).toContain('6 active')
  })

  it('describes a workspace host generation starting', () => {
    expect(formatEnvActivationBlocker(t, {
      code: 'host_generation_starting',
      detail: 'generation 7',
    })).toContain('Workspace runtime generation is starting')
  })
})

describe('computeEnvActivationOverallStatus', () => {
  it('returns healthy when storage, refresh, and snapshot all align', () => {
    expect(computeEnvActivationOverallStatus(basePersonal, baseActivation, 0)).toBe('healthy')
  })

  it('returns blocked when personal blob is unreadable', () => {
    expect(
      computeEnvActivationOverallStatus(
        { ...basePersonal, blobReadable: false },
        baseActivation,
        0,
      ),
    ).toBe('blocked')
  })

  it('returns degraded (not blocked) when blob keys are missing from workspace index', () => {
    expect(
      computeEnvActivationOverallStatus(
        {
          ...basePersonal,
          blobKeysMissingFromIndex: ['ANTHROPIC_AUTH_TOKEN'],
          workspaceIndexCount: 0,
        },
        baseActivation,
        0,
      ),
    ).toBe('degraded')
  })

  it('returns degraded (not blocked) when index lists keys absent from blob', () => {
    expect(
      computeEnvActivationOverallStatus(
        {
          ...basePersonal,
          indexKeysMissingFromBlob: ['STALE_KEY'],
        },
        baseActivation,
        0,
      ),
    ).toBe('degraded')
  })

  it('returns degraded when active runtimes exist', () => {
    expect(
      computeEnvActivationOverallStatus(
        basePersonal,
        { ...baseActivation, active_runtime_count: 2, blockers: [{ code: 'active_runtimes', detail: '2' }] },
        0,
      ),
    ).toBe('degraded')
  })

  it('returns blocked when env_not_served blocker is present', () => {
    expect(
      computeEnvActivationOverallStatus(
        basePersonal,
        {
          ...baseActivation,
          missing_served_env_keys: ['openai_api_key'],
          blockers: [{ code: 'env_not_served', detail: 'openai_api_key' }],
        },
        0,
      ),
    ).toBe('blocked')
  })

  it('returns blocked when unresolved env keys are present', () => {
    expect(
      computeEnvActivationOverallStatus(
        basePersonal,
        {
          ...baseActivation,
          unresolved_env_keys: ['team_token'],
          blockers: [{ code: 'unresolved_env_keys', detail: 'team_token' }],
        },
        0,
      ),
    ).toBe('blocked')
  })
})

describe('normalizeDaemonEnvActivationDiagnostics', () => {
  it('fills missing host_env_shadowed_keys and blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      personal_env_var_count: 2,
      personal_blob_readable: true,
    })
    expect(normalized?.host_env_shadowed_keys).toEqual([])
    expect(normalized?.override_keys).toEqual([])
    expect(normalized?.activation_status).toBe('pending')
    expect(normalized?.blockers).toEqual([])
    expect(normalized?.refresh.change_kinds).toEqual([])
  })

  it('normalizes legacy string blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      blockers: ['old message'] as unknown as DaemonEnvActivationDiagnostics['blockers'],
    })
    expect(normalized?.blockers).toEqual([{ code: 'legacy_message', detail: 'old message' }])
  })

  it('accepts the daemon camelCase wire shape', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      personalEnvVarCount: 3,
      systemEnvVarCount: 4,
      resolvedEnvFingerprint: 'resolved-hash',
      activeEnvFingerprint: 'active-hash',
      overrideKeys: ['API_KEY'],
      activationStatus: 'blocked',
    } as unknown as Partial<DaemonEnvActivationDiagnostics>)

    expect(normalized).toMatchObject({
      personal_env_var_count: 3,
      system_env_var_count: 4,
      resolved_env_fingerprint: 'resolved-hash',
      active_env_fingerprint: 'active-hash',
      override_keys: ['API_KEY'],
      activation_status: 'blocked',
    })
  })

  it('derives capacity blockers from a camelCase hostPool without explicit blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      hostPool: {
        currentGeneration: 'gen-7',
        currentLifecycle: 'ready',
        currentRevision: 'rev-1',
        requestedRevision: 'rev-2',
        pendingLifecycle: 'starting',
        currentRoutes: 6,
        drainingGenerations: 1,
        drainingRoutes: 2,
        idleAge: null,
        queuedAcquisitions: 2,
        lastError: 'OpenCode host capacity timed out (6 active, 1 draining, 2 queued)',
      },
    } as unknown as Partial<DaemonEnvActivationDiagnostics>)

    expect(normalized?.host_pool).toMatchObject({
      current_generation: 'gen-7',
      current_lifecycle: 'ready',
      pending_lifecycle: 'starting',
      queued_acquisitions: 2,
    })
    expect(normalized?.blockers).toContainEqual({
      code: 'host_generation_starting',
      detail: 'revision rev-2',
    })
    const messages = normalized?.blockers.map((blocker) =>
      formatEnvActivationBlocker(t, blocker),
    )
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('Workspace runtime generation is starting'),
      expect.stringContaining('New sessions are waiting for local runtime capacity'),
      expect.stringContaining('2 queued'),
      expect.stringContaining('Timed out waiting for local runtime capacity'),
      expect.stringContaining('6 active'),
    ]))
  })

  it('accepts snake_case pending lifecycle without claiming current generation is starting', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      host_pool: {
        ...baseActivation.host_pool,
        current_generation: 'gen-current',
        current_lifecycle: 'ready',
        requested_revision: null,
        pending_lifecycle: 'starting',
      },
    } as unknown as Partial<DaemonEnvActivationDiagnostics>)

    expect(normalized?.host_pool.pending_lifecycle).toBe('starting')
    expect(normalized?.blockers).toContainEqual({
      code: 'host_generation_starting',
      detail: null,
    })
    expect(normalized?.blockers).not.toContainEqual(expect.objectContaining({
      detail: expect.stringContaining('gen-current'),
    }))
  })

  it('preserves explicit host blockers and derives only missing codes', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      blockers: [
        { code: 'host_generation_starting', detail: 'daemon start detail' },
        { code: 'host_capacity_waiting', detail: 'daemon queue detail' },
      ],
      hostPool: {
        pendingLifecycle: 'starting',
        requestedRevision: 'rev-2',
        queuedAcquisitions: 2,
      },
    } as unknown as Partial<DaemonEnvActivationDiagnostics>)

    expect(normalized?.blockers).toEqual([
      { code: 'host_generation_starting', detail: 'daemon start detail' },
      { code: 'host_capacity_waiting', detail: 'daemon queue detail' },
    ])
  })

  it('returns null for null input', () => {
    expect(normalizeDaemonEnvActivationDiagnostics(null)).toBeNull()
  })
})

describe('normalizePersonalEnvDiagnostics', () => {
  it('fills missing hostShadowedKeys', () => {
    const normalized = normalizePersonalEnvDiagnostics({
      storageDir: 'teamclu',
      blobReadable: true,
    })
    expect(normalized?.hostShadowedKeys).toEqual([])
    expect(normalized?.indexKeysMissingFromBlob).toEqual([])
  })
})
