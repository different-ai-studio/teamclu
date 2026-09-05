/**
 * daemon-local-client.ts
 *
 * Authenticated HTTP client for the daemon's local workspace-control plane.
 * Only works when running inside Tauri (desktop) because it needs to read the
 * daemon port / token files via the `get_daemon_http_info` IPC command.
 *
 * Workspace IDs passed to all API functions are base64url-encoded absolute
 * filesystem paths — use `encodeWorkspaceId(workspacePath)` to build them.
 */

import { invoke } from '@tauri-apps/api/core'
import { normalizeDaemonEnvActivationDiagnostics } from '@/lib/diagnostics/env-diagnostics'
import { useAuthStore } from '@/stores/auth-store'
import { isTauri } from '@/lib/utils'
import { textToBase64Url } from '@/lib/base64'

// ─── Workspace ID encoding ────────────────────────────────────────────────────

/**
 * Encode an absolute workspace path into the base64url workspace-ID accepted
 * by `/v1/workspaces/:id/*` routes.
 *
 * The Rust side decodes this with `base64::URL_SAFE_NO_PAD`, so we use the
 * same alphabet (A-Z a-z 0-9 - _) with no padding.
 */
export function encodeWorkspaceId(workspacePath: string): string {
  return textToBase64Url(workspacePath)
}

// ─── Connection cache ─────────────────────────────────────────────────────────

interface DaemonHttpInfo {
  base_url: string
  root_token: string
}

interface DaemonConnection {
  baseUrl: string
  sessionToken: string
  /** Expiry time (ms since epoch). Re-exchange when this is in the past. */
  expiresAt: number
}

let _connection: DaemonConnection | null = null
let _inflight: Promise<DaemonConnection | null> | null = null

async function readDaemonHttpInfo(): Promise<DaemonHttpInfo | null> {
  try {
    return await invoke<DaemonHttpInfo | null>('get_daemon_http_info')
  } catch {
    return null
  }
}

function formatFetchNetworkError(baseUrl: string, raw: string): string {
  if (/load failed|failed to fetch|networkerror|econnrefused|connection refused/i.test(raw)) {
    return `Cannot reach amuxd daemon at ${baseUrl}. The daemon may have restarted on a new port — restart TeamClu or wait a moment and retry.`
  }
  return raw
}

/** Cached connection; null if daemon HTTP is unavailable. */
async function getConnection(): Promise<DaemonConnection | null> {
  if (!isTauri()) return null

  const info = await readDaemonHttpInfo()
  if (!info) return null

  // amuxd binds a new loopback port on every restart; drop stale cache entries.
  if (_connection && _connection.baseUrl !== info.base_url) {
    invalidateDaemonConnection()
  }

  // Return cached session when still valid (5 min buffer before expiry).
  if (_connection && Date.now() < _connection.expiresAt - 5 * 60 * 1000) {
    return _connection
  }

  // Coalesce concurrent callers.
  if (_inflight) return _inflight
  _inflight = _fetchConnection(info).finally(() => {
    _inflight = null
  })
  return _inflight
}

async function _fetchConnection(info?: DaemonHttpInfo | null): Promise<DaemonConnection | null> {
  const resolved = info ?? (await readDaemonHttpInfo())
  if (!resolved) return null

  // Exchange root token for a scoped session token.
  try {
    const resp = await fetch(`${resolved.base_url}/v1/auth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.root_token}`,
      },
      body: JSON.stringify({
        // 'admin' authorizes daemon-level config reads/writes (`/v1/config/*`,
        // e.g. switching `agents.local_agent` between opencode and pi). The
        // local desktop app owns its daemon, so it is the legitimate admin.
        scopes: ['workspace:read', 'workspace:write', 'sessions:read', 'sessions:write', 'events:read', 'admin'],
        ttl_seconds: 3600,
      }),
    })
    if (!resp.ok) {
      console.warn('[daemon-local-client] token exchange failed:', resp.status)
      return null
    }
    const data: { token?: string; expires_in?: number } = await resp.json()
    if (!data.token) return null
    _connection = {
      baseUrl: resolved.base_url,
      sessionToken: data.token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
    return _connection
  } catch (err) {
    console.warn('[daemon-local-client] failed to reach daemon HTTP:', err)
    return null
  }
}

/** Invalidate the cached session token (e.g. after the daemon restarts). */
export function invalidateDaemonConnection(): void {
  _connection = null
}

export type DaemonHttpProbe =
  | { ok: true; baseUrl: string }
  | {
      ok: false
      // 'port_file_missing': ~/.amuxd/amuxd.http.{port,token} absent (never started / cleaned).
      // 'not_running': port file present but /v1/healthz unreachable (daemon down / stale files).
      // 'token_invalid': healthz OK but the root token fails /v1/auth/exchange (stale token → restart).
      reason: 'not_tauri' | 'port_file_missing' | 'not_running' | 'token_invalid' | 'ipc_error'
    }

/** Probe daemon HTTP. Checks reachability (healthz) BEFORE auth so callers can
 * distinguish "daemon not running" from "token invalid" — they need different recovery. */
export async function probeDaemonHttp(): Promise<DaemonHttpProbe> {
  if (!isTauri()) return { ok: false, reason: 'not_tauri' }

  let info: DaemonHttpInfo | null
  try {
    info = await invoke<DaemonHttpInfo | null>('get_daemon_http_info')
  } catch (err) {
    console.warn('[daemon-local-client] get_daemon_http_info failed:', err)
    return { ok: false, reason: 'ipc_error' }
  }
  if (!info) {
    return { ok: false, reason: 'port_file_missing' }
  }

  // 1) Running? — unauthenticated healthz. Connection-refused / non-2xx => not running.
  try {
    const resp = await fetch(`${info.base_url}/v1/healthz`)
    if (!resp.ok) {
      console.warn('[daemon-local-client] healthz returned', resp.status)
      return { ok: false, reason: 'not_running' }
    }
  } catch (err) {
    console.warn('[daemon-local-client] healthz unreachable (daemon down?):', err)
    return { ok: false, reason: 'not_running' }
  }

  // 2) Token valid? — through the cache, deliberately.
  //
  // This used to invalidate the cached session and force a fresh
  // `/v1/auth/exchange` on every probe. Three pollers run this on a 20s tick,
  // and each one also wiped the connection every other caller shares — so the
  // cache was never warm and the exchange count scaled with probes, not with
  // token lifetime (measured on the box: ~33 `/v1/auth/exchange` per minute for
  // a token that lives an hour).
  //
  // `getConnection` already answers the question this step is asking. It drops
  // the cache when the daemon rebinds to a new port, refreshes 5 minutes before
  // expiry, and coalesces concurrent callers — so a non-null result means the
  // root token exchanged successfully at some point within the token's life,
  // and null means it cannot be exchanged now.
  const conn = await getConnection()
  if (!conn) return { ok: false, reason: 'token_invalid' }

  return { ok: true, baseUrl: conn.baseUrl }
}

/** True when the local daemon HTTP server responds to `/v1/healthz`. */
export async function isDaemonHttpAvailable(): Promise<boolean> {
  const probe = await probeDaemonHttp()
  return probe.ok
}

// 'ok'      — daemon's cloud session refreshes normally.
// 'expired' — refresh token terminally rejected (re-onboarding required).
// 'unknown' — daemon unreachable, or an older daemon that doesn't report it.
type DaemonCloudAuthStatus = 'ok' | 'expired' | 'unknown'

/**
 * Read the local daemon's cloud-auth session health from `/v1/info` (an
 * unauthenticated endpoint). `'expired'` means the stored refresh token was
 * terminally rejected by the auth backend — the daemon keeps retrying a dead
 * token and the desktop should re-onboard it. Best-effort: any reachability or
 * shape problem degrades to `'unknown'` (never throws).
 */
export async function fetchDaemonCloudAuthStatus(): Promise<DaemonCloudAuthStatus> {
  if (!isTauri()) return 'unknown'
  const info = await readDaemonHttpInfo()
  if (!info) return 'unknown'
  try {
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return 'unknown'
    const data: { cloud_auth?: { status?: string } } = await resp.json()
    const status = data.cloud_auth?.status
    if (status === 'expired') return 'expired'
    if (status === 'ok') return 'ok'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * This machine's stable id, as the local daemon reports it (`~/.amuxd/device-id`
 * via the unauthenticated `/v1/info`). It is the key the Cloud API binds an agent
 * actor to, so the desktop needs it before the daemon has any cloud session of
 * its own — which is why it is read from the daemon rather than minted here.
 *
 * `null` when the daemon is unreachable or predates the field. Callers must treat
 * that as "cannot resolve this machine's agent" and surface it, never fall back
 * to a locally generated id: a fresh id provisions a second agent for a machine
 * that already has one.
 */
export async function fetchDaemonDeviceId(): Promise<string | null> {
  if (!isTauri()) return null
  const info = await readDaemonHttpInfo()
  if (!info) return null
  try {
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return null
    const data: { device_id?: unknown } = await resp.json()
    const deviceId = typeof data.device_id === 'string' ? data.device_id.trim() : ''
    return deviceId || null
  } catch {
    return null
  }
}

// ─── Authenticated fetch ──────────────────────────────────────────────────────

async function daemonFetch<T>(
  path: string,
  init?: RequestInit,
  // Internal: set false to disable the single reconnect retry (prevents loops).
  allowRetry = true,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const conn = await getConnection()
  if (!conn) {
    return {
      ok: false,
      status: 0,
      error: 'amuxd daemon is not connected. Restart TeamClu or confirm amuxd is running.',
    }
  }

  let resp: Response
  try {
    resp = await fetch(`${conn.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.sessionToken}`,
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    if (allowRetry) {
      invalidateDaemonConnection()
      return daemonFetch<T>(path, init, false)
    }
    return {
      ok: false,
      status: 0,
      error: formatFetchNetworkError(conn.baseUrl, raw),
    }
  }

  if (!resp.ok) {
    // A 401 means our cached session token was rejected — most commonly because
    // the daemon restarted and minted a new root token. Drop the stale token,
    // re-exchange, and retry the request exactly once.
    if (resp.status === 401 && allowRetry) {
      invalidateDaemonConnection()
      return daemonFetch<T>(path, init, false)
    }
    const text = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, error: text }
  }

  const data: T = await resp.json()
  return { ok: true, data }
}

async function daemonFetchData<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await daemonFetch<T>(path, init)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

/**
 * `daemonFetchData` for callers in sibling modules.
 *
 * Exported so a self-contained daemon surface can live in its own file rather
 * than growing this one; it carries the same connection discovery, token
 * exchange and single reconnect retry. See `daemon-pi-auth.ts`.
 */
export async function daemonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return daemonFetchData<T>(path, init)
}

type DaemonMqttRecoveryReason =
  | 'startup'
  | 'visibility_resume'
  | 'long_visibility_resume'
  | 'network_online'
  | 'user_requested'
  | 'watchdog'
  | 'credential_rejected'

interface DaemonMqttSnapshot {
  connected: boolean
  phase: string
  worker_generation: number | null
  connection_attempt: number | null
  ready_generation: number | null
  last_error_code: string | null
  last_error_at: string | null
  last_recovery_reason: string | null
  next_retry_at: string | null
  last_ready_at: string | null
  snapshot_version: number
}

/** Read the daemon's coherent MQTT snapshot without relying on a stale event. */
export async function getDaemonMqttSnapshot(): Promise<DaemonMqttSnapshot | null> {
  try {
    const body = await daemonFetchData<{
      mqtt?: DaemonMqttSnapshot
      mqtt_connected?: boolean
    }>('/v1/info')
    if (body.mqtt) return body.mqtt
    return body.mqtt_connected == null
      ? null
      : {
          connected: body.mqtt_connected,
          phase: body.mqtt_connected ? 'Ready' : 'Recovering',
          worker_generation: null,
          connection_attempt: null,
          ready_generation: null,
          last_error_code: null,
          last_error_at: null,
          last_recovery_reason: null,
          next_retry_at: null,
          last_ready_at: null,
          snapshot_version: 0,
        }
  } catch {
    return null
  }
}

/** Wake the daemon's MQTT supervisor; this returns before broker CONNACK. */
export async function recoverDaemonMqtt(
  reason: DaemonMqttRecoveryReason,
): Promise<{ accepted: boolean; outcome: string }> {
  return daemonFetchData('/v1/mqtt/recover', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

/**
 * Like {@link daemonFetch} but does not parse a JSON body. Used for protobuf
 * POSTs that return an empty 2xx (e.g. `202 Accepted`).
 */
async function daemonFetchNoContent(
  path: string,
  init?: RequestInit,
  allowRetry = true,
): Promise<{ ok: true; status: number } | { ok: false; status: number; error: string }> {
  const conn = await getConnection()
  if (!conn) {
    return {
      ok: false,
      status: 0,
      error: 'amuxd daemon is not connected. Restart TeamClu or confirm amuxd is running.',
    }
  }

  let resp: Response
  try {
    resp = await fetch(`${conn.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.sessionToken}`,
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    if (allowRetry) {
      invalidateDaemonConnection()
      return daemonFetchNoContent(path, init, false)
    }
    return {
      ok: false,
      status: 0,
      error: formatFetchNetworkError(conn.baseUrl, raw),
    }
  }

  if (!resp.ok) {
    if (resp.status === 401 && allowRetry) {
      invalidateDaemonConnection()
      return daemonFetchNoContent(path, init, false)
    }
    const text = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, error: text || `HTTP ${resp.status}` }
  }

  return { ok: true, status: resp.status }
}

interface DaemonConfigEntry {
  key: string
  value: unknown
  display: string
  secret: boolean
}

interface DaemonMutateConfigResponse {
  key: string
  requiresReload?: boolean
  requiresRestart?: boolean
}

/** Read a single daemon.toml key via `/v1/config/:key`. Returns null when absent (404). */
async function getDaemonConfigEntry(key: string): Promise<DaemonConfigEntry | null> {
  const result = await daemonFetch<DaemonConfigEntry>(`/v1/config/${encodeURIComponent(key)}`)
  if (!result.ok) {
    if (result.status === 404) return null
    throw new Error(result.error || `failed to read config key ${key}`)
  }
  return result.data
}

/** Write a daemon.toml key. Secret values are write-only on read (see `getDaemonConfigEntry`). */
async function setDaemonConfigValue(
  key: string,
  value: string | number | boolean,
): Promise<DaemonMutateConfigResponse> {
  const result = await daemonFetch<DaemonMutateConfigResponse>(`/v1/config/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
  if (!result.ok) throw new Error(result.error || `failed to set config key ${key}`)
  return result.data
}

interface CursorAgentSettings {
  apiKeyConfigured: boolean
  defaultModel: string
}

const CURSOR_DEFAULT_MODEL = 'composer-2.5'
const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY'

/**
 * Cursor SDK backend settings. The default model is machine config
 * (daemon.toml `[agents.cursor]`); the API key is a *personal* credential and
 * lives in the personal env store (`CURSOR_API_KEY`), where the daemon reads
 * it — never in daemon.toml.
 */
export async function getCursorAgentSettings(): Promise<CursorAgentSettings> {
  const [apiKeyValue, modelEntry] = await Promise.all([
    // Presence only: `env_var_get` returns a mask when set, rejects when absent.
    invoke<string>('env_var_get', { key: CURSOR_API_KEY_ENV }).catch(() => ''),
    getDaemonConfigEntry('agents.cursor.default_model'),
  ])
  const defaultModel =
    typeof modelEntry?.value === 'string' && modelEntry.value.trim()
      ? modelEntry.value.trim()
      : CURSOR_DEFAULT_MODEL
  return {
    apiKeyConfigured: typeof apiKeyValue === 'string' && apiKeyValue.trim().length > 0,
    defaultModel,
  }
}

export async function saveCursorAgentSettings(input: {
  apiKey?: string
  defaultModel?: string
}): Promise<{ requiresRestart: boolean }> {
  let requiresRestart = false
  const trimmedKey = input.apiKey?.trim()
  if (trimmedKey) {
    await invoke('env_catalog_set', {
      scope: 'personal',
      key: CURSOR_API_KEY_ENV,
      value: trimmedKey,
    })
    // The pool captures the key at config load; a running daemon picks the
    // new one up on restart.
    requiresRestart = true
  }
  const trimmedModel = input.defaultModel?.trim()
  if (trimmedModel) {
    const resp = await setDaemonConfigValue('agents.cursor.default_model', trimmedModel)
    requiresRestart = requiresRestart || (resp.requiresRestart ?? true)
  }
  return { requiresRestart }
}

/** Restart the desktop-managed amuxd after config edits that require it. */
export async function restartLocalDaemon(): Promise<void> {
  invalidateDaemonConnection()
  await invoke('restart_local_daemon')
}

// ─── Workspace-control types (mirrors Rust workspace_control.rs) ──────────────

export interface DaemonProviderInfo {
  id: string
  display_name: string
  authenticated: boolean
  base_url?: string
  models: string[]
}

interface DaemonProviderAuthRequest {
  api_key: string
  base_url?: string
  display_name?: string
  models?: Array<{ model_id: string; model_name?: string }>
}

/** Skill-name → 'allow' | 'deny' | 'ask' */
export type DaemonPermissionMap = Record<string, 'allow' | 'deny' | 'ask'>

interface DaemonPermissionConfig {
  skills: DaemonPermissionMap
  tools: DaemonPermissionMap
}

export interface DaemonAllowlistRule {
  project_id: string
  permission: string
  pattern: string
  decision: 'allow' | 'deny'
}

export type DaemonApplyOutcome = 'applied_live' | 'reload_required' | 'restart_required'

// ─── Providers ────────────────────────────────────────────────────────────────

export async function getDaemonProviders(
  workspaceId: string,
): Promise<DaemonProviderInfo[] | null> {
  const result = await daemonFetch<DaemonProviderInfo[]>(
    `/v1/workspaces/${workspaceId}/providers`,
  )
  return result.ok ? result.data : null
}

/**
 * The device's providers, with no workspace involved (#742).
 *
 * Credentials are per-machine — which is why the write side (`/auth`,
 * `/oauth/*`, `/auth-methods`) has been device-level all along. Only the
 * listing was still workspace-scoped, so the models panel went blank before a
 * folder was opened even though the credentials behind it were right there.
 */
export async function getDeviceProviders(): Promise<DaemonProviderInfo[] | null> {
  const result = await daemonFetch<DaemonProviderInfo[]>(`/v1/providers`)
  return result.ok ? result.data : null
}

// ─── Provider auth catalog & OAuth (Phase 1 catalog, Phase 2 execution) ─────

type DaemonProviderAuthMethod = {
  type: 'oauth' | 'api'
  label: string
}

type DaemonProviderAuthMethods = Record<string, DaemonProviderAuthMethod[]>

function problemDetailFromErrorBody(error: string): { code?: string; detail: string } {
  try {
    const parsed = JSON.parse(error) as { code?: string; detail?: string }
    return {
      code: parsed.code,
      detail: parsed.detail ?? error,
    }
  } catch {
    return { detail: error }
  }
}

export async function getDaemonDeviceProviderAuthMethods(): Promise<DaemonProviderAuthMethods | null> {
  const result = await daemonFetch<DaemonProviderAuthMethods>(`/v1/providers/auth-methods`)
  return result.ok ? result.data : null
}

/** Mirrors Rust `workspaces::CatalogModel`. `ref` is `"<providerSegment>/<modelId>"`. */
interface DaemonCatalogModel {
  ref: string
  model_id: string
  display_name: string
}

/** Mirrors Rust `workspaces::BackendCatalog`. `backend` is a daemon agent type
 * id (`opencode` | `pi` | `cursor` | `claude-code`, …). */
export interface DaemonBackendCatalog {
  backend: string
  label: string
  models: DaemonCatalogModel[]
  /**
   * This device's most-recently-used model ids, newest first (daemon
   * `config::model_mru`). Omitted by the daemon when empty, and absent
   * entirely on daemons predating the field — treat as `[]`.
   */
  recent_models?: string[]
}

/** Mirrors Rust `workspaces::ModelCatalog`. */
export interface DaemonModelCatalog {
  automation_default_backend: string | null
  /**
   * Why the live probe could not answer, when it could not. Present only when
   * the catalog also came back with no models — an empty list plus this is
   * "could not ask"; an empty list without it is "nothing configured".
   */
  probe_error?: string | null
  backends: DaemonBackendCatalog[]
}

/**
 * `GET /v1/workspaces/:id/model-catalog` — models grouped by the agent backend
 * that would run them (OpenCode, Claude Code, Codex). Source of truth for the
 * cron dialog, replacing the OpenCode-only provider list.
 */
export async function getDaemonModelCatalog(
  workspaceId: string,
): Promise<DaemonModelCatalog | null> {
  const result = await daemonFetch<DaemonModelCatalog>(
    `/v1/workspaces/${workspaceId}/model-catalog`,
  )
  return result.ok ? result.data : null
}

/**
 * Device-level provider auth (#742) — credentials belong to the machine, not to
 * a directory, so this needs no workspace. Onboarding uses it to configure a
 * model provider before any project has been chosen.
 */
export async function putDaemonDeviceProviderAuth(
  providerId: string,
  req: DaemonProviderAuthRequest,
): Promise<DaemonApplyOutcome> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'POST', body: JSON.stringify(req) },
  )
  if (!result.ok) {
    const { detail } = problemDetailFromErrorBody(result.error)
    throw new Error(detail || `Failed to save provider auth (${result.status})`)
  }
  return result.data.outcome
}

export async function deleteDaemonDeviceProviderAuth(
  providerId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

export async function putDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
  req: DaemonProviderAuthRequest,
): Promise<DaemonApplyOutcome> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'POST', body: JSON.stringify(req) },
  )
  if (!result.ok) {
    const { detail } = problemDetailFromErrorBody(result.error)
    throw new Error(detail || `Failed to save provider auth (${result.status})`)
  }
  return result.data.outcome
}

export async function deleteDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * Fetch the full workspace permission config (skill + tool defaults).
 */
async function getDaemonPermissionConfig(
  workspaceId: string,
): Promise<DaemonPermissionConfig | null> {
  const result = await daemonFetch<DaemonPermissionConfig>(
    `/v1/workspaces/${workspaceId}/permissions`,
  )
  if (!result.ok) return null
  return {
    skills: result.data.skills ?? {},
    tools: result.data.tools ?? {},
  }
}

/**
 * Fetch the workspace permission map.
 * Returns a flat `{ bash: 'ask', read: 'allow', ... }` object for skill keys only.
 */
export async function getDaemonPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const config = await getDaemonPermissionConfig(workspaceId)
  return config?.skills ?? null
}

/** Tool-level permission defaults (e.g. `bash`, `read`) outside the skill map. */
export async function getDaemonToolPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const config = await getDaemonPermissionConfig(workspaceId)
  return config?.tools ?? null
}

/**
 * Replace the workspace skill permission map.
 * Pass `tools` to merge tool-level defaults; omitted/empty tools are left unchanged.
 */
export async function putDaemonPermissions(
  workspaceId: string,
  permissions: DaemonPermissionMap,
  tools?: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  const body: DaemonPermissionConfig = { skills: permissions, tools: tools ?? {} }
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permissions`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
  return result.ok ? result.data.outcome : null
}

/** Merge tool-level permission defaults without replacing skill permissions. */
export async function putDaemonToolPermissions(
  workspaceId: string,
  tools: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  return putDaemonPermissions(workspaceId, {}, tools)
}

// ─── Roles & skills ───────────────────────────────────────────────────────────

/** Mirrors `RolesSkillsWorkspaceState` from lib/roles/types.ts (camelCase from daemon). */
interface DaemonRolesSkillsState {
  roles: Array<{
    slug: string
    name: string
    description: string
    body: string
    role: string
    whenToUse: string
    workingStyle: string
    roleSkills: Array<{ name: string; description: string }>
    filePath: string
    rawMarkdown: string
  }>
  skills: Array<{
    filename: string
    name: string
    invocationName?: string
    content: string
    description: string
    source?: string
    dirPath: string
    linkedRoles: string[]
    isRoleSkill: boolean
  }>
  roleUsageBySkill: Record<string, string[]>
  skillNamesByRole: Record<string, string[]>
  metrics: {
    rolesCount: number
    skillsCount: number
    linkedSkillsCount: number
    unlinkedSkillsCount: number
  }
}

export async function getDaemonRolesSkillsState(
  workspaceId: string,
): Promise<DaemonRolesSkillsState | null> {
  const result = await daemonFetch<DaemonRolesSkillsState>(
    `/v1/workspaces/${workspaceId}/roles-skills`,
  )
  return result.ok ? result.data : null
}

export async function getDaemonSkills(
  workspaceId: string,
): Promise<DaemonRolesSkillsState['skills'] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['skills']>(
    `/v1/workspaces/${workspaceId}/skills`,
  )
  return result.ok ? result.data : null
}

interface DaemonUpsertSkillRequest {
  content: string
  skillName?: string
  dirPath?: string
  filename?: string
}

export async function putDaemonSkill(
  workspaceId: string,
  slug: string,
  req: DaemonUpsertSkillRequest,
): Promise<DaemonRolesSkillsState['skills'][number] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['skills'][number]>(
    `/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(slug)}`,
    { method: 'PUT', body: JSON.stringify(req) },
  )
  return result.ok ? result.data : null
}

/** Register a Skills refresh without rewriting files. Next idle apply disposes the OpenCode instance. */
export async function notifyDaemonSkillsChanged(workspaceId: string): Promise<void> {
  await daemonFetchData<{ ok: boolean }>(
    `/v1/workspaces/${workspaceId}/skills/refresh`,
    { method: 'POST' },
  )
}

export async function deleteDaemonSkill(
  workspaceId: string,
  slug: string,
  dirPath?: string,
): Promise<DaemonApplyOutcome | null> {
  const query = dirPath ? `?dirPath=${encodeURIComponent(dirPath)}` : ''
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(slug)}${query}`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

interface DaemonUpsertRoleRequest {
  rawMarkdown: string
  targetFilePath?: string
}

export async function putDaemonRole(
  workspaceId: string,
  slug: string,
  req: DaemonUpsertRoleRequest,
): Promise<DaemonRolesSkillsState['roles'][number] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['roles'][number]>(
    `/v1/workspaces/${workspaceId}/roles/${encodeURIComponent(slug)}`,
    { method: 'PUT', body: JSON.stringify(req) },
  )
  return result.ok ? result.data : null
}

export async function deleteDaemonRole(
  workspaceId: string,
  slug: string,
  filePath?: string,
): Promise<DaemonApplyOutcome | null> {
  const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : ''
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/roles/${encodeURIComponent(slug)}${query}`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

export async function getDaemonAllowlist(
  workspaceId: string,
): Promise<DaemonAllowlistRule[] | null> {
  const result = await daemonFetch<DaemonAllowlistRule[]>(
    `/v1/workspaces/${workspaceId}/permission-allowlist`,
  )
  return result.ok ? result.data : null
}

export async function putDaemonAllowlist(
  workspaceId: string,
  rules: DaemonAllowlistRule[],
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permission-allowlist`,
    { method: 'PUT', body: JSON.stringify(rules) },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Apps ─────────────────────────────────────────────────────────────────────

/**
 * Kick the local daemon to put a new app's files in place, in
 * `<amuxd home>/teams/<teamId>/apps/<appId>`.
 *
 * With `gitRemoteUrl` the daemon clones that repo and writes no template;
 * without it, the starter template for the app's type is written. Either way
 * this is best-effort and **non-fatal**: app creation must succeed even when
 * the daemon is down. We pass no `workdir` — the daemon owns the path and
 * reports back where it wrote, so nothing here has to re-derive it.
 *
 * Returns a three-state outcome plus that path (never throws):
 * - `"seeded"`    — the daemon accepted and completed the seed/clone.
 * - `"failed"`    — the daemon was reachable but it failed (terminal); `error`
 *   carries what it said, which for a clone is git's own reason.
 * - `"unreachable"` — the daemon is down/unreachable (status 0 or thrown);
 *   the caller should leave the app row untouched so a reseed stays available.
 */
type SeedAppOutcome = "seeded" | "failed" | "unreachable";

export interface SeedAppResult {
  outcome: SeedAppOutcome
  /** Where the app's files landed. Null unless the seed succeeded. */
  workdir: string | null
  /** Why it failed, for the toast. Null unless the outcome is `failed`. */
  error: string | null
}

function resolveSeedGitUserIdentity(): { gitUserName?: string; gitUserEmail?: string } {
  const session = useAuthStore.getState().session
  if (!session) return {}
  const meta = session.user.userMetadata ?? undefined
  const email = session.user.email?.trim() || ''
  const name =
    (typeof meta?.full_name === 'string' && meta.full_name.trim()) ||
    (typeof meta?.name === 'string' && meta.name.trim()) ||
    (email ? email.split('@')[0] : '') ||
    ''
  return {
    ...(name ? { gitUserName: name } : {}),
    ...(email ? { gitUserEmail: email } : {}),
  }
}

export async function cloneDaemonApp(
  appId: string,
  teamId: string,
  gitRemoteUrl: string,
  deployKeyPem?: string | null,
): Promise<SeedAppResult> {
  try {
    const result = await daemonFetch<{ status: string; workdir?: string }>('/v1/apps/seed', {
      method: 'POST',
      body: JSON.stringify({
        appId,
        teamId,
        gitRemoteUrl: gitRemoteUrl.trim(),
        cloneOnly: true,
        ...(deployKeyPem?.trim() ? { deployKeyPem: deployKeyPem.trim() } : {}),
        ...resolveSeedGitUserIdentity(),
      }),
    })
    if (result.ok) {
      return { outcome: "seeded", workdir: result.data.workdir?.trim() || null, error: null }
    }
    if (result.status === 0) {
      console.warn('[daemon-local-client] app clone unreachable (non-fatal):', result.error)
      return { outcome: "unreachable", workdir: null, error: null }
    }
    console.warn('[daemon-local-client] app clone failed:', result.error)
    return { outcome: "failed", workdir: null, error: result.error ?? null }
  } catch (err) {
    console.warn('[daemon-local-client] app clone unavailable (non-fatal):', err)
    return { outcome: "unreachable", workdir: null, error: null }
  }
}

export async function seedDaemonApp(
  appId: string,
  teamId: string,
  appName: string,
  appType: string,
  gitRemoteUrl?: string | null,
  deployKeyPem?: string | null,
): Promise<SeedAppResult> {
  try {
    const result = await daemonFetch<{ status: string; workdir?: string }>('/v1/apps/seed', {
      method: 'POST',
      body: JSON.stringify({
        appId,
        teamId,
        appName,
        appType,
        ...(gitRemoteUrl?.trim() ? { gitRemoteUrl: gitRemoteUrl.trim() } : {}),
        ...(deployKeyPem?.trim() ? { deployKeyPem: deployKeyPem.trim() } : {}),
        ...resolveSeedGitUserIdentity(),
      }),
    })
    if (result.ok) {
      return { outcome: "seeded", workdir: result.data.workdir?.trim() || null, error: null }
    }
    if (result.status === 0) {
      console.warn('[daemon-local-client] app seed unreachable (non-fatal):', result.error)
      return { outcome: "unreachable", workdir: null, error: null }
    }
    console.warn('[daemon-local-client] app seed failed (non-fatal):', result.error)
    return { outcome: "failed", workdir: null, error: result.error ?? null }
  } catch (err) {
    console.warn('[daemon-local-client] app seed unavailable (non-fatal):', err)
    return { outcome: "unreachable", workdir: null, error: null }
  }
}

/**
 * Kick the local daemon to build an app's artifact and upload it to OSS via the
 * presigned PUT URL minted by the cloud `deploy` call. The daemon runs the build
 * in `<amuxd home>/apps/<appId>` (it must already be seeded) and PUTs the zip.
 *
 * Three-state outcome (never throws), mirroring {@link seedDaemonApp}:
 * - `"built"`       — the daemon built + uploaded successfully.
 * - `"failed"`      — daemon reachable but the build/upload failed (terminal).
 * - `"unreachable"` — daemon down/unreachable; the caller should not finalize.
 */
type BuildAppOutcome = "built" | "failed" | "unreachable";

export interface BuildAppResult {
  outcome: BuildAppOutcome
  /** Why it failed, for the toast. Null unless the outcome is `failed`. */
  error: string | null
}

/**
 * The three git fields are all-or-nothing, and the daemon enforces that.
 *
 * With them it fetches the app's Gitea repo and builds that exact commit; with
 * none of them it builds the workdir as it sits, which is the only thing it can
 * do for an app imported from a remote this deployment has no credential for.
 */
interface BuildDaemonAppInput {
  gitCommitSha?: string | null
  gitRemoteUrl?: string | null
  deployKeyPem?: string | null
  presignedPut: string
}

/**
 * Where the local daemon keeps this app's checkout.
 *
 * Asked, never derived. The desktop used to compute `~/.amuxd/apps/<id>` from
 * the home directory; when the daemon moved its app root, the two answers
 * diverged and the agent edited a directory that no deploy ever built — the
 * deployed site stayed the seed template with nothing reporting an error.
 *
 * `teamId` names the app's team: apps live under `teams/<teamId>/apps`, and the
 * daemon falls back to whichever team it is claimed by when the caller omits
 * it — which is the wrong directory for an app from another team.
 *
 * Returns null when the daemon is unreachable or too old to answer, so callers
 * degrade to "no local path" instead of guessing a wrong one.
 */
interface DaemonAppWorkdirInfo {
  workdir: string
  deviceName: string
}

/**
 * Which apps this machine actually holds a checkout for.
 *
 * One call, not one per app: the sidebar list filters on this, and resolving a
 * workdir and reading it for each app separately was two round trips apiece on
 * every refresh.
 *
 * Returns null when the daemon is unreachable — the caller must tell that apart
 * from "no apps are local", because the two mean opposite things for what the
 * sidebar should show.
 */
export async function daemonLocalAppIds(teamId?: string | null): Promise<string[] | null> {
  try {
    const query = teamId?.trim() ? `?teamId=${encodeURIComponent(teamId.trim())}` : ''
    const result = await daemonFetch<{ appIds?: string[] }>(`/v1/apps/local${query}`)
    if (!result.ok) {
      console.warn('[daemon-local-client] local apps unavailable (non-fatal):', result.error)
      return null
    }
    return Array.isArray(result.data.appIds) ? result.data.appIds : []
  } catch (err) {
    console.warn('[daemon-local-client] local apps unavailable:', err)
    return null
  }
}

interface InspectDirResult {
  isGitRepo: boolean
  /** `origin` on that checkout, when it has one. */
  gitRemoteUrl: string | null
}

/**
 * Ask the daemon whether a picked directory is a git checkout, and where it
 * came from — before any app row exists.
 *
 * Returns null when the daemon cannot answer, which the caller must not treat
 * as "not a git repo": one is a reason to block the pick, the other is a reason
 * to say the daemon is offline.
 */
export async function inspectDaemonDir(path: string): Promise<InspectDirResult | null> {
  try {
    const result = await daemonFetch<{ isGitRepo?: boolean; gitRemoteUrl?: string }>(
      '/v1/apps/inspect-dir',
      { method: 'POST', body: JSON.stringify({ path }) },
    )
    if (!result.ok) {
      console.warn('[daemon-local-client] inspect-dir failed (non-fatal):', result.error)
      return null
    }
    return {
      isGitRepo: result.data.isGitRepo === true,
      gitRemoteUrl: result.data.gitRemoteUrl?.trim() || null,
    }
  } catch (err) {
    console.warn('[daemon-local-client] inspect-dir unavailable:', err)
    return null
  }
}

interface BindAppWorkdirResult {
  workdir: string
  /** `origin` on the bound checkout, when it has one. */
  gitRemoteUrl: string | null
}

/**
 * Point an app at a git checkout that already exists on this machine.
 *
 * Nothing is moved or written — unlike {@link moveDaemonAppWorkdir}, which
 * relocates the tree. Throws with the daemon's own reason so the picker can say
 * "not a git repository" at the moment of choosing rather than failing later.
 */
export async function bindDaemonAppWorkdir(
  appId: string,
  teamId: string,
  workdir: string,
): Promise<BindAppWorkdirResult> {
  const result = await daemonFetch<{ workdir: string; gitRemoteUrl?: string }>(
    `/v1/apps/${encodeURIComponent(appId)}/bind-workdir`,
    { method: 'POST', body: JSON.stringify({ teamId, workdir }) },
  )
  if (!result.ok) {
    throw new Error(result.error ?? 'could not bind the app to that directory')
  }
  return {
    workdir: result.data.workdir,
    gitRemoteUrl: result.data.gitRemoteUrl?.trim() || null,
  }
}

export async function daemonAppWorkdir(
  appId: string,
  teamId?: string | null,
): Promise<DaemonAppWorkdirInfo | null> {
  try {
    const query = teamId?.trim() ? `?teamId=${encodeURIComponent(teamId.trim())}` : ''
    const result = await daemonFetch<{ workdir: string; deviceName?: string }>(
      `/v1/apps/${encodeURIComponent(appId)}/workdir${query}`,
    )
    if (!result.ok) {
      console.warn('[daemon-local-client] app workdir unavailable (non-fatal):', result.error)
      return null
    }
    const workdir = result.data.workdir?.trim()
    if (!workdir) return null
    return {
      workdir,
      deviceName: result.data.deviceName?.trim() || 'Local daemon',
    }
  } catch (err) {
    console.warn('[daemon-local-client] app workdir unavailable:', err)
    return null
  }
}

type MoveAppWorkdirResult =
  | { outcome: 'moved'; workdir: string; error: null }
  | { outcome: 'unreachable'; workdir: null; error: null }
  | { outcome: 'failed'; workdir: null; error: string }

/** Relocate this app's checkout on the local daemon (entire tree, including `.git`). */
export async function moveDaemonAppWorkdir(
  appId: string,
  teamId: string,
  destPath: string,
): Promise<MoveAppWorkdirResult> {
  try {
    const result = await daemonFetch<{ workdir: string }>(
      `/v1/apps/${encodeURIComponent(appId)}/move-workdir`,
      {
        method: 'POST',
        body: JSON.stringify({
          appId,
          teamId,
          destPath: destPath.trim(),
        }),
      },
    )
    if (result.ok) {
      const workdir = result.data.workdir?.trim() || destPath.trim()
      return { outcome: 'moved', workdir, error: null }
    }
    if (result.status === 0) {
      return { outcome: 'unreachable', workdir: null, error: null }
    }
    return { outcome: 'failed', workdir: null, error: result.error ?? null }
  } catch (err) {
    console.warn('[daemon-local-client] app workdir move unavailable:', err)
    return { outcome: 'unreachable', workdir: null, error: null }
  }
}

export async function buildDaemonApp(
  appId: string,
  teamId: string,
  input: BuildDaemonAppInput,
): Promise<BuildAppResult> {
  try {
    const result = await daemonFetch<{ status: string }>('/v1/apps/build', {
      method: 'POST',
      body: JSON.stringify({
        appId,
        teamId,
        ...(input.gitCommitSha?.trim() ? { gitCommitSha: input.gitCommitSha.trim() } : {}),
        ...(input.gitRemoteUrl?.trim() ? { gitRemoteUrl: input.gitRemoteUrl.trim() } : {}),
        ...(input.deployKeyPem?.trim() ? { deployKeyPem: input.deployKeyPem.trim() } : {}),
        presignedPut: input.presignedPut.trim(),
      }),
    })
    if (result.ok) return { outcome: "built", error: null }
    if (result.status === 0) {
      console.warn('[daemon-local-client] app build unreachable (non-fatal):', result.error)
      return { outcome: "unreachable", error: null }
    }
    console.warn('[daemon-local-client] app build failed:', result.error)
    return { outcome: "failed", error: result.error ?? null }
  } catch (err) {
    console.warn('[daemon-local-client] app build unavailable:', err)
    return { outcome: "unreachable", error: null }
  }
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

/** Single MCP server config entry; mirrors `McpServerConfig` in workspace_control.rs. */
export interface DaemonMcpServerConfig {
  /** `"local"` (stdio) or `"remote"` (HTTP). May be absent for legacy entries. */
  type?: string
  /** Provenance from daemon merge: workspace custom, team shared, or built-in. */
  source?: 'workspace' | 'team' | 'inherent'
  enabled?: boolean
  /** Command + args for local stdio servers. */
  command?: string[]
  environment?: Record<string, string>
  /** Base URL for remote HTTP servers. */
  url?: string
  headers?: Record<string, string>
  timeout?: number
  [key: string]: unknown
}

export async function getDaemonMcp(
  workspaceId: string,
): Promise<Record<string, DaemonMcpServerConfig>> {
  return daemonFetchData<Record<string, DaemonMcpServerConfig>>(
    `/v1/workspaces/${workspaceId}/mcp`,
  )
}

export async function putDaemonMcp(
  workspaceId: string,
  servers: Record<string, DaemonMcpServerConfig>,
): Promise<DaemonApplyOutcome> {
  const data = await daemonFetchData<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/mcp`,
    { method: 'PUT', body: JSON.stringify(servers) },
  )
  return data.outcome
}

export interface DaemonMcpServerProbeResult {
  probe_status: 'skipped' | 'ready' | 'failed'
  tools: string[]
  error: string | null
  probed_at: string | null
}

export async function getDaemonMcpTools(
  workspaceId: string,
  options?: { refresh?: boolean },
): Promise<Record<string, DaemonMcpServerProbeResult>> {
  // Axum Query + serde_urlencoded only accept "true"/"false" for bool — not "1".
  const query = options?.refresh ? '?refresh=true' : ''
  const data = await daemonFetchData<{ servers: Record<string, DaemonMcpServerProbeResult> }>(
    `/v1/workspaces/${workspaceId}/mcp/tools${query}`,
  )
  return data.servers
}

interface DaemonTeamMcpInstallOutcome {
  teamId: string
  mcpChanged: boolean
}

interface DaemonTeamCloudReconcileOutcome {
  teamId: string
  mcpChanged: boolean
  envChanged: boolean
}

/** A documents file the manifest lists that this device has not downloaded. */
interface KnownDocument {
  /** Sync key, e.g. `documents/hr/contract.pdf`. */
  path: string
  version: number
  /** Server-side size, so the UI can say what fetching would cost. */
  size: number
}

/**
 * Documents this device knows about but has not downloaded.
 *
 * The tree is drawn from this UNION the disk scan. Nothing is written to disk
 * for an unfetched file — a zero-byte placeholder would be indistinguishable
 * from a file somebody emptied — so the scan alone can never reveal one.
 */
export async function listKnownDocuments(teamId: string): Promise<KnownDocument[]> {
  return daemonFetchData<KnownDocument[]>(
    `/v1/team/documents/known?team_id=${encodeURIComponent(teamId)}`,
  )
}

/**
 * Download listed-but-unfetched documents.
 *
 * Fails rather than queueing when offline. A queue would let a click do nothing
 * visible and produce the file twenty minutes later, when it is no longer
 * wanted — and fetching on demand is worth having precisely because the thing
 * is there when you ask for it.
 */
export async function fetchDocuments(teamId: string, paths: string[]): Promise<number> {
  const out = await daemonFetchData<{ fetched: number }>('/v1/team/documents/fetch', {
    method: 'POST',
    body: JSON.stringify({ teamId, paths }),
  })
  return out.fetched
}

/**
 * Give back the disk some documents occupy. They stay listed and can be fetched
 * again.
 *
 * NOT a delete: the server copy is untouched and no other member is affected.
 * Returns the paths actually released — a file with unpushed local edits is
 * refused and simply absent, so the caller compares what it asked for against
 * what came back rather than assuming everything worked.
 */
export async function releaseDocuments(teamId: string, paths: string[]): Promise<string[]> {
  const out = await daemonFetchData<{ released: string[] }>('/v1/team/documents/release', {
    method: 'POST',
    body: JSON.stringify({ teamId, paths }),
  })
  return out.released ?? []
}

/** Re-fetch the daemon actor's team MCP/env cache immediately. */
export async function reconcileDaemonTeamCloudConfig(): Promise<DaemonTeamCloudReconcileOutcome> {
  return daemonFetchData<DaemonTeamCloudReconcileOutcome>(
    '/v1/team/cloud-config/reconcile',
    { method: 'POST', body: JSON.stringify({}) },
  )
}

/**
 * Install a team MCP server for the daemon's own agent actor (not the desktop
 * user). The daemon is what spawns and probes the server, so the install must
 * land on the daemon's actor for the merged MCP view to contain it. The daemon
 * then re-fetches its team MCP cache before returning.
 */
export async function installDaemonTeamMcp(name: string): Promise<DaemonTeamMcpInstallOutcome> {
  return daemonFetchData<DaemonTeamMcpInstallOutcome>(
    `/v1/team/mcp-servers/${encodeURIComponent(name)}/install`,
    { method: 'PUT', body: JSON.stringify({}) },
  )
}

/** Uninstall a team MCP server for the daemon's own agent actor. */
export async function uninstallDaemonTeamMcp(name: string): Promise<DaemonTeamMcpInstallOutcome> {
  return daemonFetchData<DaemonTeamMcpInstallOutcome>(
    `/v1/team/mcp-servers/${encodeURIComponent(name)}/install`,
    { method: 'DELETE' },
  )
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export type DaemonRuntimeRefreshStatus = 'clean' | 'pending' | 'applying' | 'failed'

export interface DaemonRuntimeRefresh {
  status: DaemonRuntimeRefreshStatus
  change_kinds: string[]
  recommended_action: 'none' | 'apply_changes'
  auto_apply_blocked_by_active_runtime: boolean
  last_detected_at: string | null
  last_error: string | null
}

interface DaemonRuntimeStatus {
  workspace_id: string
  ready: boolean
  backend: string
  current_model: string | null
  refresh: DaemonRuntimeRefresh
}

export async function getDaemonRuntime(
  workspaceId: string,
): Promise<DaemonRuntimeStatus | null> {
  const result = await daemonFetch<DaemonRuntimeStatus>(
    `/v1/workspaces/${workspaceId}/runtime`,
  )
  return result.ok ? result.data : null
}

export async function reloadDaemonRuntime(
  workspaceId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/runtime/reload`,
    { method: 'POST' },
  )
  return result.ok ? result.data.outcome : null
}

/** Queue runtime refresh kinds for idle auto-apply (does not reload immediately). */
export async function notifyDaemonRuntimePendingChanges(
  workspaceId: string,
  changeKinds: string[],
): Promise<boolean> {
  const result = await daemonFetch<{ ok: boolean }>(
    `/v1/workspaces/${workspaceId}/runtime/pending-changes`,
    {
      method: 'POST',
      body: JSON.stringify({ change_kinds: changeKinds }),
    },
  )
  return result.ok
}

interface DaemonEnvActivationBlocker {
  code: string
  detail?: string | null
}

interface DaemonEnvKeyActivationStatus {
  key: string
  scope: 'personal' | 'team' | 'system'
  status: string
}

interface DaemonUnresolvedConfigPlaceholder {
  path: string
  placeholder: string
  key: string
}

export interface DaemonDomainHostStats {
  current_generation: string | null
  current_lifecycle: string | null
  pending_lifecycle: string | null
  current_revision: string | null
  requested_revision: string | null
  current_routes: number
  draining_generations: number
  draining_routes: number
  idle_age: { secs: number; nanos: number } | null
  queued_acquisitions: number
  last_error: string | null
}

export interface DaemonEnvActivationDiagnostics {
  personal_env_var_count: number
  personal_blob_user_var_count: number
  personal_blob_readable: boolean
  personal_load_error: string | null
  team_env_var_count: number
  system_env_var_count: number
  opencode_serve_running: boolean
  opencode_serve_cached_env_count: number
  active_runtime_count: number
  workspace_has_active_turn: boolean
  refresh: DaemonRuntimeRefresh
  host_pool: DaemonDomainHostStats
  host_env_shadowed_keys: string[]
  resolved_env_fingerprint: string | null
  active_env_fingerprint: string | null
  override_keys: string[]
  alias_collision_keys: string[]
  unresolved_env_keys: string[]
  snapshot_conflict_workspace: string | null
  activation_status: 'active' | 'pending' | 'blocked'
  blockers: DaemonEnvActivationBlocker[]
  expected_env_keys: string[]
  effective_env_keys: string[]
  missing_expected_keys: string[]
  key_statuses: DaemonEnvKeyActivationStatus[]
  mcp_unresolved_placeholders: DaemonUnresolvedConfigPlaceholder[]
  installed_env_fingerprint: string | null
  active_handle_env_fingerprint: string | null
  team_secret_configured: boolean
  opencode_serve_cached_env_keys: string[]
  missing_served_env_keys: string[]
  active_handle_env_keys: string[]
}

export async function getDaemonEnvActivationDiagnostics(
  workspaceId: string,
  teamId?: string | null,
): Promise<DaemonEnvActivationDiagnostics | null> {
  const query = teamId?.trim() ? `?team_id=${encodeURIComponent(teamId.trim())}` : ''
  const result = await daemonFetch<DaemonEnvActivationDiagnostics>(
    `/v1/workspaces/${workspaceId}/runtime/env-diagnostics${query}`,
  )
  return result.ok ? normalizeDaemonEnvActivationDiagnostics(result.data) : null
}

// ─── Team share ───────────────────────────────────────────────────────────────

interface DaemonTeamLinkResult {
  team_id: string
  /** `symlink` | `junction` | `fallback` | `legacy_retained` */
  status: 'symlink' | 'junction' | 'fallback' | 'legacy_retained'
  /** `~/.amuxd/teams/<team_id>/teamclu-team` */
  global_dir: string
}

/**
 * Ask the local daemon to materialize the team's global dir + this workspace's
 * `teamclu-team` symlink *now* — called right after enabling/joining
 * team-share so the synced directory exists immediately instead of waiting for
 * the daemon's next start or the first runtime (the AddWorkspace path rides
 * MQTT, which may not be connected right after onboarding).
 *
 * Best-effort: returns `null` when the daemon HTTP is unavailable or the call
 * fails (e.g. the daemon isn't onboarded to a team). The link is still created
 * lazily later, so a failure here is non-fatal to enabling team-share.
 */
/**
 * Thrown (as an Error message) when the local daemon is too old to create the
 * team folder without a workspace — it still requires `path` on
 * `POST /v1/team/link`. A contract string, not a message: the UI has to
 * recognise it to say something useful instead of surfacing the daemon's raw
 * "missing field `path`" deserialization complaint.
 */
export const TEAM_LINK_LEGACY_DAEMON = 'team_link_legacy_daemon'

export async function linkDaemonTeamWorkspace(
  workspacePath: string | null,
  options?: { strict?: boolean },
): Promise<DaemonTeamLinkResult | null> {
  // No workspace is a valid request: the team's own directory belongs to the
  // team, and materializing it is the half of this call a client with no folder
  // open actually needs. The daemon then skips the workspace link only.
  const path = workspacePath?.trim() || null
  try {
    const result = await daemonFetch<DaemonTeamLinkResult>('/v1/team/link', {
      method: 'POST',
      body: JSON.stringify(path ? { path } : {}),
    })
    if (!result.ok) {
      const raw = result.error ?? 'daemon team link failed'
      const msg = !path && /missing field .?path/.test(raw) ? TEAM_LINK_LEGACY_DAEMON : raw
      if (options?.strict) throw new Error(msg)
      console.warn('[daemon-local-client] team link failed:', msg)
      return null
    }
    return result.data
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (options?.strict) throw new Error(msg, { cause: err })
    // Network/IPC errors (daemon not running, no HTTP) are expected and
    // non-fatal — the link is created lazily on the daemon's next start.
    console.warn('[daemon-local-client] team link unavailable:', msg)
    return null
  }
}

/**
 * Deliver a `teamclu.LiveEventEnvelope` to the local daemon over loopback
 * (`POST /v1/session-live/ingest`). Same `route_session_message` sink as MQTT
 * `amux/{team}/session/{id}/live`, including `message_id` dedup — so a later
 * MQTT copy of the same envelope is a no-op.
 */
export async function ingestSessionLiveLocally(
  sessionId: string,
  liveEnvelopeBytes: Uint8Array,
): Promise<void> {
  const sid = sessionId.trim()
  if (!sid) throw new Error('session_id is required')
  if (liveEnvelopeBytes.byteLength === 0) {
    throw new Error('empty live envelope payload')
  }

  const result = await daemonFetchNoContent(
    `/v1/session-live/ingest?session_id=${encodeURIComponent(sid)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      // `fetch` accepts a Uint8Array at runtime; only TypeScript's `BodyInit`
      // rejects `Uint8Array<ArrayBufferLike>` since the lib tightened its
      // generics. Cast rather than wrap — a Blob would change what actually
      // goes on the wire.
      body: liveEnvelopeBytes as unknown as BodyInit,
    },
  )
  if (!result.ok) {
    throw new Error(result.error || `live ingest failed (${result.status})`)
  }
}
