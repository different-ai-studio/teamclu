use anyhow::Result;
use rumqttc::{
    AsyncClient, ConnectReturnCode, Event, EventLoop, LastWill, MqttOptions, Outgoing, Packet, QoS,
    Request, SubAck, Subscribe, SubscribeFilter, SubscribeReasonCode, Transport,
};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};
use teamclu_transport::MqttBroker;
use tokio::sync::Mutex;

pub struct ClientConfig {
    pub broker_url: Option<String>,
    pub broker_host: String,
    pub broker_port: u16,
    pub client_id: String,
    pub username: String,
    pub password: String,
    pub team_id: String,
    pub use_tls: bool,
}

pub struct MqttClient {
    pub client: AsyncClient,
    pub event_loop: Arc<Mutex<EventLoop>>,
    pub client_id: String,
}

impl MqttClient {
    fn resolve_broker(cfg: &ClientConfig) -> MqttBroker {
        let broker_url = cfg
            .broker_url
            .as_deref()
            .filter(|url| !url.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let scheme = if cfg.use_tls { "mqtts" } else { "mqtt" };
                format!("{}://{}:{}", scheme, cfg.broker_host, cfg.broker_port)
            });
        MqttBroker::parse(&broker_url)
    }

    pub fn connect(cfg: ClientConfig) -> Result<Self> {
        let opts = build_mqtt_options(&cfg, false);
        let (client, event_loop) = AsyncClient::new(opts, 64);
        Ok(Self {
            client,
            event_loop: Arc::new(Mutex::new(event_loop)),
            client_id: cfg.client_id,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttProbeResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub connack_code: Option<String>,
    pub broker_url: String,
}

fn build_mqtt_options(cfg: &ClientConfig, clean_session: bool) -> MqttOptions {
    let broker = MqttClient::resolve_broker(cfg);
    let mut opts = MqttOptions::new(&cfg.client_id, broker.connection_address(), broker.port);
    opts.set_credentials(&cfg.username, &cfg.password);
    opts.set_clean_session(clean_session);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_max_packet_size(4 * 1024 * 1024, 4 * 1024 * 1024);

    // Not `wss_with_default_config()` / `tls_with_default_config()`: both build
    // `TlsConfiguration::default()`, which panics the process when the platform
    // cert store cannot be read. See `super::tls`.
    if broker.is_websocket() && broker.use_tls {
        opts.set_transport(Transport::Wss(super::tls::default_tls_config()));
    } else if broker.is_websocket() {
        opts.set_transport(Transport::Ws);
    } else if broker.use_tls {
        opts.set_transport(Transport::tls_with_config(super::tls::default_tls_config()));
    }

    if !clean_session {
        let lwt_topic = super::topics::actor_state(&cfg.team_id, &cfg.client_id);
        let lwt_payload = serde_json::json!({"status":"offline"})
            .to_string()
            .into_bytes();
        opts.set_last_will(LastWill::new(
            lwt_topic,
            lwt_payload,
            QoS::AtLeastOnce,
            true,
        ));
    }

    opts
}

#[derive(Debug)]
struct PendingRecovery {
    packet_id: Option<u16>,
    filters: Vec<SubscribeFilter>,
    session_present: bool,
}

#[derive(Debug, Default)]
struct SubscriptionRecovery {
    /// Requests retained by rumqttc across a disconnect. They must not run
    /// before the response subscriptions have been restored.
    deferred: VecDeque<Request>,
    pending: Option<PendingRecovery>,
}

#[derive(Debug, PartialEq, Eq)]
enum RecoveryResult {
    NotRecoveryAck,
    Restored {
        subscription_count: usize,
        session_present: bool,
        deferred_count: usize,
    },
    Failed(String),
}

impl SubscriptionRecovery {
    /// Places the recovery SUBSCRIBE directly at the front of rumqttc's
    /// event-loop queue. Using `AsyncClient::subscribe_many().await` here can
    /// deadlock because this same task is the only consumer of its bounded
    /// request channel. Moving the existing pending requests aside also keeps
    /// stale RPC publishes from overtaking the recovery subscription.
    fn prepare(
        &mut self,
        event_loop_pending: &mut VecDeque<Request>,
        topics: Vec<String>,
        session_present: bool,
    ) -> usize {
        self.pending = None;
        self.deferred.append(event_loop_pending);

        if topics.is_empty() {
            event_loop_pending.append(&mut self.deferred);
            return 0;
        }

        let filters: Vec<SubscribeFilter> = topics
            .into_iter()
            .map(|path| SubscribeFilter::new(path, QoS::AtLeastOnce))
            .collect();
        let subscribe = Subscribe::new_many(filters.clone());
        let subscription_count = subscribe.filters.len();
        event_loop_pending.push_back(Request::Subscribe(subscribe));
        self.pending = Some(PendingRecovery {
            packet_id: None,
            filters,
            session_present,
        });
        subscription_count
    }

    fn observe_outgoing(&mut self, outgoing: &Outgoing, event_loop_pending: &VecDeque<Request>) {
        if let (Some(pending), Outgoing::Subscribe(packet_id)) = (&mut self.pending, outgoing) {
            let recovery_request_is_still_queued = event_loop_pending.iter().any(|request| {
                matches!(request, Request::Subscribe(subscribe) if subscribe.filters == pending.filters)
            });
            if pending.packet_id.is_none() && !recovery_request_is_still_queued {
                pending.packet_id = Some(*packet_id);
            }
        }
    }

    fn finish(
        &mut self,
        event_loop_pending: &mut VecDeque<Request>,
        ack: &SubAck,
    ) -> RecoveryResult {
        let Some(pending) = self.pending.as_ref() else {
            return RecoveryResult::NotRecoveryAck;
        };
        if pending.packet_id != Some(ack.pkid) {
            return RecoveryResult::NotRecoveryAck;
        }

        let pending = self.pending.take().expect("pending recovery checked above");
        if ack.return_codes.len() != pending.filters.len() {
            return RecoveryResult::Failed(format!(
                "broker returned {} SUBACK result(s) for {} subscription(s)",
                ack.return_codes.len(),
                pending.filters.len()
            ));
        }
        if ack.return_codes.contains(&SubscribeReasonCode::Failure) {
            return RecoveryResult::Failed(
                "broker rejected one or more restored subscriptions".to_string(),
            );
        }

        let deferred_count = self.deferred.len();
        event_loop_pending.append(&mut self.deferred);
        RecoveryResult::Restored {
            subscription_count: pending.filters.len(),
            session_present: pending.session_present,
            deferred_count,
        }
    }

    fn connection_lost(&mut self, event_loop_pending: &mut VecDeque<Request>) {
        // The recovery SUBSCRIBE itself is not retained by rumqttc's clean-up
        // path. Keep the deferred application requests and retry a fresh
        // recovery SUBSCRIBE after the next successful CONNACK.
        let Some(pending) = self.pending.take() else {
            return;
        };
        if let Some(index) = event_loop_pending.iter().position(|request| {
            matches!(request, Request::Subscribe(subscribe) if subscribe.filters == pending.filters)
        }) {
            event_loop_pending.remove(index);
        }
    }
}

/// One-shot broker reachability probe. Does not touch the shared [`MqttBus`].
pub async fn probe_broker(cfg: ClientConfig, timeout: Duration) -> MqttProbeResult {
    let broker_url = cfg
        .broker_url
        .clone()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| {
            let scheme = if cfg.use_tls { "mqtts" } else { "mqtt" };
            format!("{}://{}:{}", scheme, cfg.broker_host, cfg.broker_port)
        });
    let started = Instant::now();
    let deadline = started + timeout;

    let opts = build_mqtt_options(&cfg, true);
    let (client, mut event_loop) = AsyncClient::new(opts, 8);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = client.disconnect().await;
            return MqttProbeResult {
                ok: false,
                latency_ms: None,
                error: Some(format!("probe timed out after {}ms", timeout.as_millis())),
                connack_code: None,
                broker_url,
            };
        }

        match tokio::time::timeout(remaining, event_loop.poll()).await {
            Ok(Ok(Event::Incoming(Packet::ConnAck(ack)))) => {
                let latency_ms = started.elapsed().as_millis() as u64;
                let connack_code = format!("{:?}", ack.code);
                let _ = client.disconnect().await;
                if ack.code == ConnectReturnCode::Success {
                    return MqttProbeResult {
                        ok: true,
                        latency_ms: Some(latency_ms),
                        error: None,
                        connack_code: Some(connack_code),
                        broker_url,
                    };
                }
                return MqttProbeResult {
                    ok: false,
                    latency_ms: Some(latency_ms),
                    error: Some(format!("broker refused connection: {connack_code}")),
                    connack_code: Some(connack_code),
                    broker_url,
                };
            }
            Ok(Ok(_)) => continue,
            Ok(Err(e)) => {
                let _ = client.disconnect().await;
                return MqttProbeResult {
                    ok: false,
                    latency_ms: None,
                    error: Some(e.to_string()),
                    connack_code: None,
                    broker_url,
                };
            }
            Err(_) => {
                let _ = client.disconnect().await;
                return MqttProbeResult {
                    ok: false,
                    latency_ms: None,
                    error: Some(format!("probe timed out after {}ms", timeout.as_millis())),
                    connack_code: None,
                    broker_url,
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wss_bootstrap_url_uses_port_443_not_js_fallback_1883() {
        let broker = MqttClient::resolve_broker(&ClientConfig {
            broker_url: Some("wss://mqtt.example.com/mqtt".into()),
            broker_host: "mqtt.example.com".into(),
            broker_port: 1883,
            client_id: "teamclu-test".into(),
            username: "actor".into(),
            password: "token".into(),
            team_id: "team-1".into(),
            use_tls: true,
        });
        assert_eq!(broker.connection_address(), "wss://mqtt.example.com/mqtt");
        assert_eq!(broker.port, 443);
    }

    #[test]
    fn recovery_subscribe_precedes_a_full_deferred_queue() {
        let mut event_loop_pending = (0..64)
            .map(|index| {
                Request::Publish(rumqttc::Publish::new(
                    format!("rpc/{index}"),
                    QoS::AtLeastOnce,
                    vec![index as u8],
                ))
            })
            .collect::<VecDeque<_>>();
        let mut recovery = SubscriptionRecovery::default();

        assert_eq!(
            recovery.prepare(
                &mut event_loop_pending,
                vec!["rpc/response".to_string(), "session/live".to_string()],
                false,
            ),
            2
        );
        assert_eq!(event_loop_pending.len(), 1);
        assert!(matches!(
            event_loop_pending.front(),
            Some(Request::Subscribe(subscribe)) if subscribe.filters.len() == 2
        ));
        assert_eq!(recovery.deferred.len(), 64);
    }

    #[test]
    fn successful_suback_restores_deferred_requests_in_order() {
        let first = Request::Publish(rumqttc::Publish::new(
            "rpc/first",
            QoS::AtLeastOnce,
            vec![1],
        ));
        let second = Request::Publish(rumqttc::Publish::new(
            "rpc/second",
            QoS::AtLeastOnce,
            vec![2],
        ));
        let mut event_loop_pending = VecDeque::from([first.clone(), second.clone()]);
        let mut recovery = SubscriptionRecovery::default();
        recovery.prepare(
            &mut event_loop_pending,
            vec!["rpc/response".to_string()],
            true,
        );
        event_loop_pending.clear();
        recovery.observe_outgoing(&Outgoing::Subscribe(7), &event_loop_pending);

        assert_eq!(
            recovery.finish(
                &mut event_loop_pending,
                &SubAck::new(7, vec![SubscribeReasonCode::Success(QoS::AtLeastOnce)],),
            ),
            RecoveryResult::Restored {
                subscription_count: 1,
                session_present: true,
                deferred_count: 2,
            }
        );
        assert_eq!(event_loop_pending, VecDeque::from([first, second]));
    }

    #[test]
    fn failed_or_unrelated_suback_never_releases_deferred_publish() {
        let mut event_loop_pending = VecDeque::from([Request::Publish(rumqttc::Publish::new(
            "rpc/request",
            QoS::AtLeastOnce,
            vec![1],
        ))]);
        let mut recovery = SubscriptionRecovery::default();
        recovery.prepare(
            &mut event_loop_pending,
            vec!["rpc/response".to_string()],
            false,
        );
        event_loop_pending.clear();
        recovery.observe_outgoing(&Outgoing::Subscribe(11), &event_loop_pending);

        assert_eq!(
            recovery.finish(
                &mut event_loop_pending,
                &SubAck::new(12, vec![SubscribeReasonCode::Success(QoS::AtLeastOnce)],),
            ),
            RecoveryResult::NotRecoveryAck
        );
        assert_eq!(recovery.deferred.len(), 1);
        assert_eq!(
            recovery.finish(
                &mut event_loop_pending,
                &SubAck::new(11, vec![SubscribeReasonCode::Failure]),
            ),
            RecoveryResult::Failed(
                "broker rejected one or more restored subscriptions".to_string()
            )
        );
        assert!(event_loop_pending.is_empty());
        assert_eq!(recovery.deferred.len(), 1);

        recovery.prepare(
            &mut event_loop_pending,
            vec!["rpc/response".to_string()],
            false,
        );
        event_loop_pending.clear();
        recovery.observe_outgoing(&Outgoing::Subscribe(13), &event_loop_pending);
        assert!(matches!(
            recovery.finish(
                &mut event_loop_pending,
                &SubAck::new(13, vec![SubscribeReasonCode::Success(QoS::AtLeastOnce)],),
            ),
            RecoveryResult::Restored {
                deferred_count: 1,
                ..
            }
        ));
        assert_eq!(event_loop_pending.len(), 1);
    }

    #[test]
    fn stale_outgoing_subscribe_does_not_capture_recovery_packet_id() {
        let mut event_loop_pending = VecDeque::new();
        let mut recovery = SubscriptionRecovery::default();
        recovery.prepare(
            &mut event_loop_pending,
            vec!["rpc/response".to_string()],
            false,
        );

        recovery.observe_outgoing(&Outgoing::Subscribe(4), &event_loop_pending);
        assert_eq!(recovery.pending.as_ref().unwrap().packet_id, None);

        event_loop_pending.pop_front();
        recovery.observe_outgoing(&Outgoing::Subscribe(5), &event_loop_pending);
        assert_eq!(recovery.pending.as_ref().unwrap().packet_id, Some(5));
    }
}

pub async fn run_event_loop(bus: Arc<super::MqttBusInner>, app: tauri::AppHandle, generation: u64) {
    use rumqttc::{ConnectReturnCode, Event, Packet};
    use tauri::Emitter;

    // Burst-coalescing forwarder. The daemon drains ACP events in ~50ms
    // batches, so publishes arrive in bursts. Collect everything within an
    // 8ms window into ONE `mqtt:envelopes` emit — cuts webview IPC wakeups
    // ~10x during streaming. Payload bytes are base64 (a serde_json number
    // array would otherwise ~4x the size). Lives for this generation: when
    // run_event_loop returns, env_tx drops and the forwarder exits.
    let (env_tx, mut env_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Vec<u8>)>();
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            use base64::Engine as _;
            while let Some(first) = env_rx.recv().await {
                let mut batch = vec![first];
                let deadline = tokio::time::Instant::now() + Duration::from_millis(8);
                while let Ok(Some(next)) = tokio::time::timeout_at(deadline, env_rx.recv()).await {
                    batch.push(next);
                }
                for (topic, bytes) in &batch {
                    super::dock_attention::maybe_request_dock_attention(&app, topic, bytes);
                }
                let payload: Vec<serde_json::Value> = batch
                    .iter()
                    .map(|(topic, bytes)| {
                        serde_json::json!({
                            "topic": topic,
                            "b64": base64::engine::general_purpose::STANDARD
                                .encode(bytes),
                        })
                    })
                    .collect();
                let _ = app.emit("mqtt:envelopes", payload);
            }
        });
    }

    let mut backoff_secs: u64 = 1;
    let mut recovery = SubscriptionRecovery::default();
    loop {
        if bus.current_generation() != generation {
            return;
        }
        let event_loop_arc = {
            let guard = bus.client.lock().await;
            guard.as_ref().map(|c| c.event_loop.clone())
        };
        if bus.current_generation() != generation {
            return;
        }
        let Some(event_loop) = event_loop_arc else {
            let event_guard = bus.event_gate.read().await;
            if bus.current_generation() != generation {
                return;
            }
            bus.set_connected_for_generation(generation, false);
            drop(event_guard);
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        let mut event_loop = event_loop.lock().await;
        let poll_result = event_loop.poll().await;
        if bus.current_generation() != generation {
            return;
        }
        // Keep explicit `mqtt_connect` from retiring this generation between
        // the ownership check and its state/UI side effects.
        let event_guard = bus.event_gate.read().await;
        if bus.current_generation() != generation {
            return;
        }
        match poll_result {
            Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                if ack.code == ConnectReturnCode::Success {
                    let mut topics: Vec<String> =
                        bus.subscribed.lock().await.iter().cloned().collect();
                    if bus.current_generation() != generation {
                        return;
                    }
                    topics.sort_unstable();
                    let subscription_count =
                        recovery.prepare(&mut event_loop.pending, topics, ack.session_present);
                    if subscription_count == 0 {
                        backoff_secs = 1;
                        if !bus.set_connected_for_generation(generation, true) {
                            return;
                        }
                        tracing::info!(
                            session_present = ack.session_present,
                            "mqtt CONNACK: success; no subscriptions to restore"
                        );
                        let _ = app.emit("mqtt:connected", true);
                    } else {
                        tracing::info!(
                            session_present = ack.session_present,
                            subscription_count,
                            "mqtt CONNACK: success; waiting for subscription restore SUBACK"
                        );
                    }
                } else {
                    // The broker accepted the TCP/TLS socket but refused the MQTT
                    // session (e.g. bad credentials). Surface the reason instead of
                    // flashing "connected" and letting the socket-close error below
                    // silently flip us back to red with no explanation.
                    recovery.connection_lost(&mut event_loop.pending);
                    bus.set_connected_for_generation(generation, false);
                    let msg = format!("broker refused connection: {:?}", ack.code);
                    tracing::warn!("mqtt {msg}");
                    let _ = app.emit("mqtt:connected", false);
                    let _ = app.emit("mqtt:error", msg.as_str());
                }
            }
            Ok(Event::Incoming(Packet::SubAck(ack))) => {
                match recovery.finish(&mut event_loop.pending, &ack) {
                    RecoveryResult::NotRecoveryAck => {}
                    RecoveryResult::Restored {
                        subscription_count,
                        session_present,
                        deferred_count,
                    } => {
                        backoff_secs = 1;
                        if !bus.set_connected_for_generation(generation, true) {
                            return;
                        }
                        tracing::info!(
                            session_present,
                            subscription_count,
                            deferred_count,
                            "mqtt subscriptions restored and connection ready"
                        );
                        let _ = app.emit("mqtt:connected", true);
                    }
                    RecoveryResult::Failed(error) => {
                        bus.set_connected_for_generation(generation, false);
                        // Never release already-accepted QoS requests when a
                        // restore is rejected. Disconnect first, retain them,
                        // and retry the restore on the next CONNACK.
                        event_loop
                            .pending
                            .push_front(Request::Disconnect(rumqttc::Disconnect));
                        let msg = format!("mqtt subscription restore failed: {error}");
                        tracing::warn!("{msg}");
                        let _ = app.emit("mqtt:connected", false);
                        let _ = app.emit("mqtt:error", msg.as_str());
                    }
                }
            }
            Ok(Event::Incoming(Packet::Disconnect)) => {
                recovery.connection_lost(&mut event_loop.pending);
                bus.set_connected_for_generation(generation, false);
                tracing::warn!("mqtt broker sent DISCONNECT");
                let _ = app.emit("mqtt:connected", false);
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                if bus.is_connected() {
                    backoff_secs = 1;
                }
                let _ = env_tx.send((p.topic.clone(), p.payload.to_vec()));
            }
            Ok(Event::Outgoing(outgoing)) => {
                if bus.is_connected() {
                    backoff_secs = 1;
                }
                recovery.observe_outgoing(&outgoing, &event_loop.pending);
            }
            Ok(_) => {
                if bus.is_connected() {
                    backoff_secs = 1;
                }
            }
            Err(e) => {
                recovery.connection_lost(&mut event_loop.pending);
                bus.set_connected_for_generation(generation, false);
                let msg = e.to_string();
                let _ = app.emit("mqtt:connected", false);
                // Surface the connection failure (auth rejection, refused socket,
                // TLS error, …) to the UI. Previously this only went to the log.
                let _ = app.emit("mqtt:error", msg.as_str());
                tracing::warn!("mqtt event loop error: {msg}, retry in {backoff_secs}s");
                drop(event_loop);
                drop(event_guard);
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        }
    }
}
