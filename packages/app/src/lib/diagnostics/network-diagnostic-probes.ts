export interface HttpProbeResult {
  url: string
  ok: boolean
  status: number | null
  latencyMs: number | null
  error: string | null
}

export interface CloudProbeSeries {
  healthUrl: string
  samples: HttpProbeResult[]
  successRate: number
  latencyMin: number | null
  latencyMax: number | null
  latencyAvg: number | null
  jitterMs: number | null
}

export interface MqttEventSummary {
  windowMinutes: number
  errorCount: number
  disconnectCount: number
  reconnectCount: number
  lastError: string | null
}

const DEFAULT_TIMEOUT_MS = 8_000

export async function probeHttp(
  url: string,
  options?: {
    headers?: Record<string, string>
    timeoutMs?: number
    method?: 'GET' | 'HEAD'
  },
): Promise<HttpProbeResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = performance.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const resp = await fetch(url, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      signal: controller.signal,
    })
    clearTimeout(timer)
    const latencyMs = Math.round(performance.now() - started)
    return {
      url,
      ok: resp.ok,
      status: resp.status,
      latencyMs,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    }
  } catch (err) {
    return {
      url,
      ok: false,
      status: null,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function probeCloudEndpointSeries(
  baseUrl: string,
  path: string,
  sampleCount = 3,
): Promise<CloudProbeSeries | null> {
  const trimmed = baseUrl.replace(/\/$/, '')
  if (!trimmed) return null
  const targetUrl = `${trimmed}${path.startsWith('/') ? path : `/${path}`}`
  const samples: HttpProbeResult[] = []
  for (let i = 0; i < sampleCount; i += 1) {
    samples.push(await probeHttp(targetUrl, { method: 'GET' }))
    if (i < sampleCount - 1) {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  const okSamples = samples.filter((s) => s.ok && s.latencyMs != null)
  const latencies = okSamples.map((s) => s.latencyMs as number)
  const latencyMin = latencies.length ? Math.min(...latencies) : null
  const latencyMax = latencies.length ? Math.max(...latencies) : null
  const latencyAvg = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null
  const jitterMs =
    latencyMin != null && latencyMax != null ? latencyMax - latencyMin : null
  return {
    healthUrl: targetUrl,
    samples,
    successRate: samples.filter((s) => s.ok).length / samples.length,
    latencyMin,
    latencyMax,
    latencyAvg,
    jitterMs,
  }
}

/** @deprecated Use probeCloudEndpointSeries — kept as alias for healthz-only probes. */
export async function probeCloudHealthSeries(
  baseUrl: string,
  sampleCount = 3,
): Promise<CloudProbeSeries | null> {
  return probeCloudEndpointSeries(baseUrl, '/healthz', sampleCount)
}

type MqttDiagEvent = {
  ts: string
  scope: string
  event: string
  data?: unknown
}

function eventDataMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  if (typeof rec.message === 'string') return rec.message
  if (rec.error && typeof rec.error === 'object') {
    const err = rec.error as { message?: string }
    if (typeof err.message === 'string') return err.message
  }
  if (typeof rec.state === 'string' && rec.state === 'disconnected') return 'disconnected'
  return null
}

export function summarizeMqttNetworkEvents(
  events: MqttDiagEvent[],
  windowMs = 15 * 60_000,
): MqttEventSummary {
  const cutoff = Date.now() - windowMs
  let errorCount = 0
  let disconnectCount = 0
  let reconnectCount = 0
  let lastError: string | null = null

  for (const entry of events) {
    const ts = Date.parse(entry.ts)
    if (!Number.isFinite(ts) || ts < cutoff) continue

    const event = entry.event.toLowerCase()
    const dataMsg = eventDataMessage(entry.data)

    if (event.includes('error') || event.endsWith(':error')) {
      errorCount += 1
      if (dataMsg) lastError = dataMsg
    }

    if (event.includes('disconnect')) {
      disconnectCount += 1
    }

    if (event.includes('reconnect')) {
      reconnectCount += 1
    }

    if (event === 'state' && typeof entry.data === 'object') {
      const state = (entry.data as { state?: string }).state
      if (state === 'disconnected') disconnectCount += 1
      if (state === 'connected') reconnectCount += 1
    }
  }

  return {
    windowMinutes: Math.round(windowMs / 60_000),
    errorCount,
    disconnectCount,
    reconnectCount,
    lastError,
  }
}

export function parseBrokerHost(mqttUrl?: string, mqttHost?: string): string | null {
  if (mqttHost?.trim()) return mqttHost.trim()
  if (!mqttUrl?.trim()) return null
  try {
    return new URL(mqttUrl).hostname || null
  } catch {
    return null
  }
}
