use crate::mqtt::client::{probe_broker, MqttProbeResult};
use crate::mqtt::{ClientConfig, MqttBus, MqttClient};
use rumqttc::QoS;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, Deserialize)]
pub struct MqttStatus {
    pub connected: bool,
    pub subscribed_topics: Vec<String>,
}

#[tauri::command]
pub async fn mqtt_connect(
    app: AppHandle,
    bus: State<'_, MqttBus>,
    broker_url: Option<String>,
    broker_host: String,
    broker_port: u16,
    username: String,
    password: String,
    client_id: String,
    team_id: String,
    use_tls: bool,
) -> Result<(), String> {
    let cfg = ClientConfig {
        broker_url,
        broker_host,
        broker_port,
        client_id,
        username,
        password,
        team_id,
        use_tls,
    };
    let client = MqttClient::connect(cfg).map_err(|e| e.to_string())?;
    let (generation, previous_client) = {
        let _client_guard = bus.client_gate.write().await;
        let _event_guard = bus.event_gate.write().await;
        let generation = bus.bump_generation();
        let previous_client = bus.client.lock().await.replace(client);
        bus.subscribed.lock().await.clear();
        (generation, previous_client)
    };
    if let Some(previous_client) = previous_client {
        // The retired event loop may already have stopped draining its bounded
        // channel. Never wait for capacity on a client that no longer owns the
        // generation.
        let _ = previous_client.client.try_disconnect();
    }

    let bus_arc = (*bus).clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::mqtt::client::run_event_loop(bus_arc, app_clone, generation).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn mqtt_subscribe(bus: State<'_, MqttBus>, topic: String) -> Result<(), String> {
    let _client_guard = bus.client_gate.read().await;
    let client = bus
        .client
        .lock()
        .await
        .as_ref()
        .ok_or("mqtt not connected")?
        .client
        .clone();
    client
        .subscribe(&topic, QoS::AtLeastOnce)
        .await
        .map_err(|e| e.to_string())?;
    bus.subscribed.lock().await.insert(topic);
    Ok(())
}

#[tauri::command]
pub async fn mqtt_unsubscribe(bus: State<'_, MqttBus>, topic: String) -> Result<(), String> {
    let _client_guard = bus.client_gate.read().await;
    let client = bus
        .client
        .lock()
        .await
        .as_ref()
        .ok_or("mqtt not connected")?
        .client
        .clone();
    client
        .unsubscribe(&topic)
        .await
        .map_err(|e| e.to_string())?;
    bus.subscribed.lock().await.remove(&topic);
    Ok(())
}

/// Takes the payload base64-encoded, not as `Vec<u8>`.
///
/// PERF-16: a `Vec<u8>` argument arrives as a JSON array of decimal numbers,
/// so a protobuf envelope crossed the IPC boundary at three to four times its
/// size and the webview built that array one `Array.from` element at a time.
#[tauri::command]
pub async fn mqtt_publish(
    bus: State<'_, MqttBus>,
    topic: String,
    payload_b64: String,
    retain: bool,
) -> Result<(), String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64.as_bytes())
        .map_err(|e| format!("mqtt_publish: payload is not valid base64: {e}"))?;

    let _client_guard = bus.client_gate.read().await;
    let generation = bus.ready_generation().ok_or("mqtt not ready")?;
    let client_guard = bus.client.lock().await;
    if bus.ready_generation() != Some(generation) {
        return Err("mqtt not ready".to_string());
    }
    let client = client_guard
        .as_ref()
        .ok_or("mqtt not connected")?
        .client
        .clone();
    drop(client_guard);
    client
        .publish(&topic, QoS::AtLeastOnce, retain, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mqtt_status(bus: State<'_, MqttBus>) -> Result<MqttStatus, String> {
    // Honest connection check: the bus's `connected` flag is only true after
    // the event loop has observed a CONNACK from the broker and not since seen
    // a network error or DISCONNECT. The previous heuristic (`client.is_some()`)
    // reported "connected" even when the TCP/TLS connection had died silently.
    let connected = bus.is_connected();
    let subscribed_topics: Vec<String> = bus.subscribed.lock().await.iter().cloned().collect();
    Ok(MqttStatus {
        connected,
        subscribed_topics,
    })
}

const DEFAULT_PROBE_TIMEOUT_MS: u64 = 8_000;

/// One-shot MQTT broker reachability probe (does not replace the live client).
#[tauri::command]
pub async fn mqtt_probe(
    broker_url: Option<String>,
    broker_host: String,
    broker_port: u16,
    username: String,
    password: String,
    team_id: String,
    use_tls: bool,
    timeout_ms: Option<u64>,
) -> Result<MqttProbeResult, String> {
    let client_id = format!("teamclu-probe-{}", uuid::Uuid::new_v4().simple());
    let cfg = ClientConfig {
        broker_url,
        broker_host,
        broker_port,
        client_id,
        username,
        password,
        team_id,
        use_tls,
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_PROBE_TIMEOUT_MS));
    Ok(probe_broker(cfg, timeout).await)
}
