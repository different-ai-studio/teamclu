//! NATS connection + subscribe wiring for amuxd. Parallel to
//! `crate::mqtt::MqttClient`.
//!
//! Connection options:
//! - URL handed to async_nats verbatim (nats://, tls://, ws://, wss://)
//! - Cloud bearer JWT supplied as a token via `async_nats::ConnectOptions::token`,
//!   verified server-side by the NATS auth_callout service
//! - Name = `amuxd-<actor_id[..8]>` for monitoring (matches MQTT client_id)
//!
//! LWT equivalent: NATS has no LWT, so the daemon explicitly publishes
//! an `online=false` ActorPresence to the JetStream KV retained bucket on
//! graceful shutdown. Unclean disconnects are detected server-side by the
//! callout service via NATS connection events (handled outside the daemon).

use async_nats::{Client, ConnectOptions};
use std::sync::Arc;
use teamclu_transport::nats::NatsClient;
use teamclu_transport::{DeliveryGuarantee, IncomingFrame, MessagePublisher};
use teamclu_types::mqtt::MQTT_FALLBACK_TEAM_ID;
use tokio::sync::mpsc;
use tracing::info;

use crate::config::DaemonConfig;
use crate::mqtt::Topics;
use crate::proto::amux::ActorPresence;

use super::retained::RetainedKv;

pub struct NatsBackend {
    pub client: NatsClient,
    pub inbound: mpsc::Receiver<IncomingFrame>,
    pub topics: Topics,
    pub retained: RetainedKv,
}

impl NatsBackend {
    /// Connect to nats-server using the given URL and Cloud bearer JWT token.
    /// Initializes the retained-state JetStream KV bucket idempotently.
    pub async fn connect(
        config: &DaemonConfig,
        url: &str,
        token: &str,
    ) -> crate::error::Result<Self> {
        let name = format!("amuxd-{}", &config.actor.id[..8.min(config.actor.id.len())]);

        let raw: Client = ConnectOptions::new()
            .name(name)
            .token(token.to_string())
            .connect(url)
            .await
            .map_err(|e| crate::error::AmuxError::Config(format!("nats connect: {e}")))?;
        info!(url, "NATS connected");

        let retained = RetainedKv::ensure(&raw).await?;

        let (client, inbound) = NatsClient::new(raw);
        let team_id = config.team_id.as_deref().unwrap_or(MQTT_FALLBACK_TEAM_ID);
        let topics = Topics::new(team_id, &config.actor.id);

        Ok(Self {
            client,
            inbound,
            topics,
            retained,
        })
    }

    /// Subscribe to the same set of base topics the MQTT path subscribes to.
    pub async fn subscribe_all(&self) -> crate::error::Result<()> {
        let topic = self.topics.runtime_commands_wildcard();
        self.client
            .subscribe(&topic, DeliveryGuarantee::AtLeastOnce)
            .await?;
        info!(%topic, "NATS subscribed to runtime commands wildcard");
        Ok(())
    }

    /// Publish online state to the retained KV bucket and (legacy parity)
    /// fire-and-forget on the core subject so any non-KV subscribers can
    /// still see it during the migration window.
    pub async fn announce_online(&self, display_name: &str) -> crate::error::Result<()> {
        let state = ActorPresence {
            online: true,
            display_name: display_name.into(),
            timestamp: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        let bytes = state.encode_to_vec();
        let topic = self.topics.actor_state();
        self.retained.put(&topic, bytes.clone()).await?;
        self.client
            .publish(&topic, bytes, true, DeliveryGuarantee::AtLeastOnce)
            .await?;
        Ok(())
    }

    /// Publish offline state to the retained KV bucket. Used at graceful
    /// shutdown and during JWT-refresh reconnect so other devices see the
    /// presence drop without waiting for the server-side callout to notice
    /// the closed NATS connection.
    pub async fn announce_offline(&self, display_name: &str) -> crate::error::Result<()> {
        // Offline snapshot: no attachments, no catalog — see the MQTT LWT.
        let state = ActorPresence {
            online: false,
            display_name: display_name.into(),
            timestamp: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        let bytes = state.encode_to_vec();
        let topic = self.topics.actor_state();
        self.retained.put(&topic, bytes).await?;
        Ok(())
    }

    /// Return an `Arc<dyn MessagePublisher>` for SessionManager / live / rpc /
    /// notify. Same shape as `Arc::new(mqtt.client.clone())` on the MQTT path.
    #[allow(dead_code)]
    pub fn publisher(&self) -> Arc<dyn MessagePublisher> {
        Arc::new(self.client.clone())
    }

    /// Lift the inbound receiver out so the daemon's main loop can `select!`
    /// on it without holding a `&mut self.nats` borrow alongside other
    /// `&mut self` method calls. Replaced by a placeholder closed channel
    /// until [`Self::inbound_put_back`] runs.
    pub fn inbound_take(&mut self) -> mpsc::Receiver<IncomingFrame> {
        let (_tx, placeholder) = mpsc::channel(1);
        std::mem::replace(&mut self.inbound, placeholder)
    }

    /// Re-attach a previously taken receiver. The main loop calls this
    /// before re-entering the outer reconnect loop so a subsequent
    /// `inbound_take()` works.
    pub fn inbound_put_back(&mut self, rx: mpsc::Receiver<IncomingFrame>) {
        self.inbound = rx;
    }
}
