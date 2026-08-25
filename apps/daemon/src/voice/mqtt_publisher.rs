//! [`VoicePublisher`] over the daemon's shared transport.
//!
//! [`super::spk`] defines publishing as a trait so the speech downlink can be
//! tested without a broker. This is the real implementation, sitting on
//! `teamclu_transport::MessagePublisher` rather than on rumqttc directly — the
//! same seam `mqtt::publisher::Publisher` uses, so the voice path works over
//! either the MQTT or NATS backend without knowing which it is on.
//!
//! ## QoS
//!
//! ctl is QoS 1 and audio is QoS 0, and the asymmetry is deliberate. Losing a
//! `spk_start` means the device never arms its decoder and the whole reply is
//! discarded silently (`onSpkFrame` drops everything while `g_playing` is
//! false), so control must arrive. A lost 20 ms audio frame is a click; a
//! *re-sent* one arrives after the samples around it have already played, so
//! retrying costs more than dropping. Nothing here is retained: a device that
//! reconnects mid-reply should hear silence, not the middle of an old answer.

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_transport::{DeliveryGuarantee, MessagePublisher};

use super::spk::VoicePublisher;

pub struct TransportVoicePublisher {
    client: Arc<dyn MessagePublisher>,
}

impl TransportVoicePublisher {
    pub fn new(client: Arc<dyn MessagePublisher>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl VoicePublisher for TransportVoicePublisher {
    async fn publish(&self, topic: String, payload: Vec<u8>, qos1: bool) -> Result<(), String> {
        let delivery = if qos1 {
            DeliveryGuarantee::AtLeastOnce
        } else {
            DeliveryGuarantee::AtMostOnce
        };
        self.client
            .publish(&topic, payload, false, delivery)
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use teamclu_transport::PublisherError;
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct SpyPublisher {
        sent: Mutex<Vec<(String, usize, bool, DeliveryGuarantee)>>,
        fail: bool,
    }

    #[async_trait]
    impl MessagePublisher for SpyPublisher {
        async fn publish(
            &self,
            topic: &str,
            payload: Vec<u8>,
            retain: bool,
            delivery: DeliveryGuarantee,
        ) -> Result<(), PublisherError> {
            if self.fail {
                return Err(PublisherError::Unavailable("offline".into()));
            }
            self.sent
                .lock()
                .await
                .push((topic.to_string(), payload.len(), retain, delivery));
            Ok(())
        }
        async fn subscribe(
            &self,
            _topic: &str,
            _delivery: DeliveryGuarantee,
        ) -> Result<(), PublisherError> {
            Ok(())
        }
        async fn unsubscribe(&self, _topic: &str) -> Result<(), PublisherError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn ctl_is_qos1_and_audio_is_qos0() {
        // The asymmetry is load-bearing (see the module docs), and nothing
        // downstream would notice if it silently flipped.
        let spy = Arc::new(SpyPublisher::default());
        let p = TransportVoicePublisher::new(spy.clone());
        p.publish("amux/t/a/voice/ctl".into(), b"{}".to_vec(), true)
            .await
            .expect("ctl");
        p.publish("amux/t/a/voice/spk".into(), vec![0u8; 40], false)
            .await
            .expect("frame");

        let sent = spy.sent.lock().await;
        assert_eq!(sent[0].3, DeliveryGuarantee::AtLeastOnce, "ctl must arrive");
        assert_eq!(
            sent[1].3,
            DeliveryGuarantee::AtMostOnce,
            "audio must not retry"
        );
    }

    #[tokio::test]
    async fn nothing_is_retained() {
        // A retained frame would be replayed to a device that reconnects
        // later — it would hear a fragment of an answer to a question it
        // already forgot asking.
        let spy = Arc::new(SpyPublisher::default());
        let p = TransportVoicePublisher::new(spy.clone());
        p.publish("amux/t/a/voice/spk".into(), vec![1, 2, 3], false)
            .await
            .expect("frame");
        p.publish("amux/t/a/voice/ctl".into(), b"{}".to_vec(), true)
            .await
            .expect("ctl");
        assert!(spy.sent.lock().await.iter().all(|s| !s.2));
    }

    #[tokio::test]
    async fn a_transport_failure_surfaces_rather_than_being_swallowed() {
        // `pump_audio` stops publishing on the first error; if this returned
        // Ok it would keep encoding a whole reply into a dead socket.
        let spy = Arc::new(SpyPublisher {
            fail: true,
            ..Default::default()
        });
        let p = TransportVoicePublisher::new(spy);
        let err = p
            .publish("amux/t/a/voice/spk".into(), vec![0; 10], false)
            .await
            .expect_err("transport is down");
        assert!(err.contains("offline"), "lost the cause: {err}");
    }
}
