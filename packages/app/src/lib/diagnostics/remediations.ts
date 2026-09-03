import type { DiagnosticCauseCode, DiagnosticFinding } from './types'

export type RemediationId =
  | 'relogin'
  | 'reconnect_mqtt'
  | 'reset_daemon'
  | 'open_llm'
  | 'reselect_model'
  | 'retry_diagnose'
  | 'export_report'

export interface RemediationAction {
  id: RemediationId
  label: string
  tone: 'default' | 'danger'
}

const EXPORT: RemediationAction = {
  id: 'export_report',
  label: '导出诊断包',
  tone: 'default',
}

const ACTION: Record<RemediationId, RemediationAction> = {
  relogin: { id: 'relogin', label: '重新登录', tone: 'danger' },
  reconnect_mqtt: { id: 'reconnect_mqtt', label: '重连 MQTT', tone: 'default' },
  reset_daemon: { id: 'reset_daemon', label: '重置 daemon', tone: 'danger' },
  open_llm: { id: 'open_llm', label: '重新连接 Provider', tone: 'default' },
  reselect_model: { id: 'reselect_model', label: '重新选择模型', tone: 'default' },
  retry_diagnose: { id: 'retry_diagnose', label: '重新诊断', tone: 'default' },
  export_report: EXPORT,
}

const PRIMARY: Partial<Record<DiagnosticCauseCode, RemediationId[]>> = {
  'auth.session_invalid': ['relogin'],
  'realtime.mqtt_auth_failed': ['relogin'],
  'realtime.mqtt_network_failed': ['reconnect_mqtt'],
  'realtime.mqtt_desktop_only': ['reconnect_mqtt'],
  'realtime.mqtt_daemon_only': ['reconnect_mqtt'],
  'realtime.sse_fallback': ['reconnect_mqtt'],
  'realtime.topic_empty': ['reconnect_mqtt'],
  'send.mqtt_publish_failed': ['reconnect_mqtt'],
  'model.daemon_unreachable': ['reset_daemon'],
  'auth.daemon_cloud_expired': ['reset_daemon'],
  'send.runtime_ensure_failed': ['reset_daemon'],
  'send.local_ingest_failed': ['reset_daemon'],
  'agent.runtime_inactive': ['reset_daemon'],
  'model.provider_not_configured': ['open_llm'],
  'model.backend_probe_failed': ['open_llm'],
  'model.team_gateway_unconfigured': ['open_llm'],
  'agent.model_provider_error': ['open_llm'],
  'agent.turn_timeout': ['reselect_model'],
  'send.delivered_no_turn': ['reselect_model', 'retry_diagnose'],
  'model.catalog_unknown': ['retry_diagnose'],
  'send.cloud_insert_failed': ['retry_diagnose'],
  'send.outbox_failed': ['retry_diagnose'],
}

export function remediationsForFinding(
  finding: Pick<DiagnosticFinding, 'code' | 'status'>,
): RemediationAction[] {
  if (finding.status === 'ok') return []
  const primary = (PRIMARY[finding.code] ?? []).map((id) => ACTION[id])
  return [...primary, EXPORT]
}

export function causeCodesFromFindings(
  findings: Array<Pick<DiagnosticFinding, 'code' | 'status'>>,
): DiagnosticCauseCode[] {
  const seen = new Set<DiagnosticCauseCode>()
  const codes: DiagnosticCauseCode[] = []
  for (const finding of findings) {
    if (finding.status === 'ok' || seen.has(finding.code)) continue
    seen.add(finding.code)
    codes.push(finding.code)
  }
  return codes
}
