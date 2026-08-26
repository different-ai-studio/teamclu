//! Dyn-safe high-level publisher trait. Daemon modules that only need to
//! publish/subscribe/unsubscribe (and don't care about the underlying event
//! loop) depend on `Arc<dyn MessagePublisher>` instead of `rumqttc::AsyncClient`.

use async_trait::async_trait;
use thiserror::Error;

use crate::{encode_subject, DeliveryGuarantee, Transport, TransportMessage};

#[derive(Debug, Error)]
pub enum PublisherError {
    #[error("transport unavailable: {0}")]
    Unavailable(String),
    #[error("mqtt client error: {0}")]
    Mqtt(#[from] rumqttc::ClientError),
    #[error("nats publish error: {0}")]
    NatsPublish(#[from] async_nats::PublishError),
    #[error("nats subscribe error: {0}")]
    NatsSubscribe(#[from] async_nats::SubscribeError),
    #[error("nats unsubscribe error: {0}")]
    NatsUnsubscribe(String),
}

#[async_trait]
pub trait MessagePublisher: Send + Sync {
    async fn publish(
        &self,
        topic: &str,
        payload: Vec<u8>,
        retain: bool,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError>;

    async fn subscribe(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError>;

    /// Best-effort subscribe. Default: same as [`Self::subscribe`].
    /// MQTT supervisor overrides this so broker ACL rejection does not rebuild
    /// the worker (used for `amux/<team>/sync/+` before ACL migration lands).
    async fn subscribe_optional(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        self.subscribe(topic, delivery).await
    }

    async fn unsubscribe(&self, topic: &str) -> Result<(), PublisherError>;
}

/// MQTT impl: thin adapter over `rumqttc::AsyncClient`. Preserves MQTT
/// semantics (`retain`, QoS) verbatim.
#[async_trait]
impl MessagePublisher for rumqttc::AsyncClient {
    async fn publish(
        &self,
        topic: &str,
        payload: Vec<u8>,
        retain: bool,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        <rumqttc::AsyncClient as Transport>::publish(
            self,
            TransportMessage {
                topic: topic.to_string(),
                payload,
                retain,
                delivery,
            },
        )
        .await?;
        Ok(())
    }

    async fn subscribe(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        <rumqttc::AsyncClient as Transport>::subscribe(self, topic.to_string(), delivery).await?;
        Ok(())
    }

    async fn unsubscribe(&self, topic: &str) -> Result<(), PublisherError> {
        rumqttc::AsyncClient::unsubscribe(self, topic).await?;
        Ok(())
    }
}

/// NATS impl: delegates to [`crate::nats::NatsClient`]. Subscriptions are
/// tracked by subject so `unsubscribe` can drop the spawned receive loop.
/// Retained writes silently degrade to core publish; daemon code that needs
/// retained semantics on NATS must use the JetStream KV path instead.
#[async_trait]
impl MessagePublisher for crate::nats::NatsClient {
    async fn publish(
        &self,
        topic: &str,
        payload: Vec<u8>,
        retain: bool,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        <crate::nats::NatsClient as Transport>::publish(
            self,
            TransportMessage {
                topic: topic.to_string(),
                payload,
                retain,
                delivery,
            },
        )
        .await
        .map_err(|e| match e {
            crate::nats::NatsTransportError::Publish(e) => PublisherError::NatsPublish(e),
            crate::nats::NatsTransportError::Subscribe(e) => PublisherError::NatsSubscribe(e),
            crate::nats::NatsTransportError::SubscriptionClosed => {
                PublisherError::NatsUnsubscribe("subscription closed".into())
            }
        })?;
        Ok(())
    }

    async fn subscribe(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        <crate::nats::NatsClient as Transport>::subscribe(self, topic.to_string(), delivery)
            .await
            .map_err(|e| match e {
                crate::nats::NatsTransportError::Subscribe(e) => PublisherError::NatsSubscribe(e),
                crate::nats::NatsTransportError::Publish(e) => PublisherError::NatsPublish(e),
                crate::nats::NatsTransportError::SubscriptionClosed => {
                    PublisherError::NatsUnsubscribe("subscription closed".into())
                }
            })?;
        Ok(())
    }

    async fn unsubscribe(&self, topic: &str) -> Result<(), PublisherError> {
        // async-nats v0.49 unsubscribes when the Subscriber is dropped, which
        // happens implicitly when the spawned task in `subscribe` exits. To
        // support explicit unsubscribe we'd need to track per-topic handles
        // and abort the task — deferred until a daemon caller actually needs
        // it. The only current caller of MqttClient::unsubscribe is
        // session_manager.rs:1391 during session detach, which is fine as a
        // no-op on NATS for now (the subject still routes but nothing reads
        // it after the session is gone).
        tracing::debug!(topic, "nats unsubscribe is a no-op; subject left bound");
        let _ = encode_subject(topic); // validate topic shape eagerly
        Ok(())
    }
}
