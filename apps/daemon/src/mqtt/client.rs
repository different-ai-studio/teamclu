use rumqttc::{AsyncClient, EventLoop, MqttOptions, QoS, Transport};
use std::sync::Arc;
use std::time::Duration;
use teamclu_transport::MqttBroker;
use tracing::{info, warn};

use crate::config::DaemonConfig;
use crate::proto::amux::ActorPresence;

use super::Topics;
use teamclu_types::mqtt::MQTT_FALLBACK_TEAM_ID;

const MQTT_MAX_PACKET_SIZE_BYTES: usize = 4 * 1024 * 1024;

pub struct MqttClient {
    pub client: AsyncClient,
    pub eventloop: EventLoop,
    pub topics: Topics,
}

/// Danger: accepts any TLS certificate (for self-signed brokers)
pub mod client_danger {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    pub struct NoCertVerifier;

    impl ServerCertVerifier for NoCertVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }
}

impl MqttClient {
    /// Placeholder client when no broker URL is known yet. `run()` rebuilds the
    /// real client after token/bootstrap succeed.
    pub fn new_placeholder(config: &DaemonConfig) -> crate::error::Result<Self> {
        let mut pending = config.clone();
        pending.mqtt.broker_url = "mqtt://127.0.0.1:1883".to_string();
        Self::new(&pending, &config.actor.id, "")
    }

    pub fn new(config: &DaemonConfig, actor_id: &str, token: &str) -> crate::error::Result<Self> {
        let client_id = format!("amuxd-{}", &config.actor.id[..8.min(config.actor.id.len())]);

        let broker = MqttBroker::parse(&config.mqtt.broker_url);
        let mut opts = MqttOptions::new(&client_id, broker.connection_address(), broker.port);
        let username = config.mqtt.username.as_deref().unwrap_or(actor_id);
        let password = config.mqtt.password.as_deref().unwrap_or(token);
        opts.set_credentials(username, password);
        opts.set_keep_alive(Duration::from_secs(30));
        opts.set_clean_session(true);
        // The worker persists inbound frames before acknowledging them. This
        // prevents a slow/full durable inbox from turning QoS1 delivery into
        // an in-memory-only handoff.
        opts.set_manual_acks(true);
        // ACP live events can carry full LLM chunks and tool-call payloads.
        // Match the desktop client so daemon-originated session/live publishes
        // do not trip rumqttc's 10 KiB default packet cap.
        opts.set_max_packet_size(MQTT_MAX_PACKET_SIZE_BYTES, MQTT_MAX_PACKET_SIZE_BYTES);

        // Not `wss_with_default_config()` / `tls_with_default_config()`: both
        // build `TlsConfiguration::default()`, which panics the process when the
        // platform cert store cannot be read. See `teamclu_transport::tls`.
        if broker.is_websocket() && broker.use_tls {
            opts.set_transport(Transport::Wss(
                teamclu_transport::tls::default_tls_config().config,
            ));
        } else if broker.is_websocket() {
            opts.set_transport(Transport::Ws);
        } else if broker.use_tls && std::env::var("AMUXD_MQTT_INSECURE_TLS").as_deref() == Ok("1") {
            warn!("AMUXD_MQTT_INSECURE_TLS=1: MQTT TLS certificate verification is disabled");
            let mut tls_config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(client_danger::NoCertVerifier))
                .with_no_client_auth();
            tls_config.alpn_protocols = vec![];

            opts.set_transport(Transport::tls_with_config(
                rumqttc::TlsConfiguration::Rustls(Arc::new(tls_config)),
            ));
        } else if broker.use_tls {
            opts.set_transport(Transport::tls_with_config(
                teamclu_transport::tls::default_tls_config().config,
            ));
        }

        // LWT: publish offline status if daemon disconnects unexpectedly
        let team_id = config.team_id.as_deref().unwrap_or(MQTT_FALLBACK_TEAM_ID);
        let topics = Topics::new(team_id, &config.actor.id);
        // The will says "this actor is gone"; the catalog and live-session
        // fields are deliberately empty — a dead daemon holds no attachments.
        let lwt_payload = ActorPresence {
            online: false,
            display_name: config.actor.name.clone(),
            timestamp: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        // LWT fires on amux/{team}/{actor}/state. Legacy /status topic has
        // been retired; subscribers treat offline-on-/state as authoritative
        // (offline-wins merge).
        let lwt = rumqttc::LastWill::new(
            topics.actor_state(),
            lwt_payload.encode_to_vec(),
            QoS::AtLeastOnce,
            true,
        );
        opts.set_last_will(lwt);

        // Channel capacity must exceed the number of subscribe + publish
        // requests issued back-to-back during startup before the eventloop
        // is first polled. Today that's ~26 subs (1 runtime/+/commands,
        // 3 teamclu base topics, ~22 session/live) plus 1 device-state
        // publish plus N retained-runtime publishes (one per stored
        // session). With 100 we deadlocked at ~75 stored sessions because
        // the channel filled before the main loop could drain it. 1024
        // gives multi-thousand-session headroom; the buffer is bounded so
        // there's still backpressure for runaway publish loops.
        let (client, eventloop) = AsyncClient::new(opts, 1024);

        Ok(Self {
            client,
            eventloop,
            topics,
        })
    }

    #[allow(dead_code)]
    pub async fn announce_online(&self, display_name: &str) -> Result<(), rumqttc::ClientError> {
        let status = ActorPresence {
            online: true,
            display_name: display_name.into(),
            timestamp: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        self.client
            .publish(
                self.topics.actor_state(),
                QoS::AtLeastOnce,
                true,
                status.encode_to_vec(),
            )
            .await
    }

    pub async fn subscribe_all(&self) -> Result<(), rumqttc::ClientError> {
        self.client
            .subscribe(self.topics.runtime_commands_wildcard(), QoS::AtLeastOnce)
            .await?;
        info!("subscribed to {}", self.topics.runtime_commands_wildcard(),);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ActorConfig, AgentsConfig, DaemonConfig, MqttConfig};

    fn test_config() -> DaemonConfig {
        DaemonConfig {
            voice: None,
            actor: ActorConfig {
                id: "abc123defg".into(),
                name: "test-device".into(),
            },
            mqtt: MqttConfig {
                broker_url: "mqtt://localhost:1883".into(),
                username: None,
                password: None,
            },
            agents: AgentsConfig::default(),
            transport: None,
            team_id: Some("team-uuid-1234".into()),
            channels: Default::default(),
            idle_runtime_timeout_secs: None,
            max_attachments: None,
            http: None,
            team_share: crate::config::TeamShareConfig::default(),
            log: None,
            locale: None,
        }
    }

    #[test]
    fn new_succeeds_with_token_credentials() {
        let config = test_config();
        let result = MqttClient::new(&config, "actor-uuid-1234", "jwt-token-value");
        assert!(
            result.is_ok(),
            "MqttClient::new should succeed with token credentials"
        );
    }

    #[test]
    fn new_allows_large_agent_live_events() {
        let config = test_config();
        let client = MqttClient::new(&config, "actor-uuid-1234", "jwt-token-value").unwrap();

        assert_eq!(
            client.eventloop.mqtt_options.max_packet_size(),
            4 * 1024 * 1024
        );
        assert_eq!(
            client.eventloop.state.max_outgoing_packet_size,
            4 * 1024 * 1024
        );
    }
}
