import * as React from 'react'
import { useMqttReconnectStore } from '@/stores/mqtt-reconnect'

// Returns the shared MQTT connection state as known by the Rust side.
// `null` = unknown yet (initial probe in flight, or non-Tauri context).
//
// All consumers read one shared store value (wired once via `ensureWired`), so
// independent components — the settings "Server" card and the sidebar
// "MQTT disconnected" notice — can never disagree the way they did when each
// hook instance kept its own state and one could miss the `mqtt:connected`
// event. The wiring also keeps `useMqttReconnectStore.lastError` in sync from
// the Rust `mqtt:error` event.
export function useMqttConnected(): boolean | null {
  const connected = useMqttReconnectStore((s) => s.connected)
  const ensureWired = useMqttReconnectStore((s) => s.ensureWired)
  React.useEffect(() => {
    ensureWired()
  }, [ensureWired])
  return connected
}
