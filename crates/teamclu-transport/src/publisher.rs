//! Dyn-safe high-level publisher trait. Daemon modules that only need to
//! publish/subscribe/unsubscribe (and don't care about the underlying event
//! loop) depend on `Arc<dyn MessagePublisher>` instead of `rumqttc::AsyncClient`.

use async_trait::async_trait;
use thiserror::Error;

use crate::{DeliveryGuarantee, Transport, TransportMessage};

#[derive(Debug, Error)]
pub enum PublisherError {
    #[error("transport unavailable: {0}")]
    Unavailable(String),
    #[error("mqtt client error: {0}")]
    Mqtt(#[from] rumqttc::ClientError),
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
