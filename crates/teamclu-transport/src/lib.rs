//! Transport abstraction for amuxd over MQTT (rumqttc).
//!
//! Public surface:
//!
//! - [`MqttBroker`]: broker URL parsing
//! - [`DeliveryGuarantee`] + [`TransportMessage`]: outbound message shape
//! - [`IncomingFrame`]: inbound message shape (transport-agnostic)
//! - [`Transport`]: per-protocol low-level publish/subscribe trait
//! - [`MessagePublisher`]: dyn-safe high-level trait used by daemon modules
//!   (teamclu::SessionManager, live, rpc, notify) so they don't depend on
//!   rumqttc directly
//! - [`tls::default_tls_config`]: panic-free replacement for rumqttc's
//!   `TlsConfiguration::default()`
//! - [`doh`]: system-DNS-first MQTT dial with a single DoH retry after a
//!   TLS certificate failure (ISP hijack mitigation)

pub mod doh;
pub mod publisher;
pub mod tls;
pub use publisher::{MessagePublisher, PublisherError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MqttBroker {
    pub host: String,
    pub port: u16,
    pub use_tls: bool,
    websocket: bool,
    url: String,
}

impl MqttBroker {
    pub fn parse(url: &str) -> Self {
        let (scheme, host_and_path) = url.split_once("://").unwrap_or(("mqtt", url));
        let (use_tls, websocket, default_port) = match scheme {
            "mqtts" => (true, false, 8883),
            "ws" => (false, true, 80),
            "wss" => (true, true, 443),
            _ => (false, false, 1883),
        };
        let host_port = host_and_path.split('/').next().unwrap_or_default();

        let (host, port) = if let Some((host, port)) = host_port.split_once(':') {
            (
                host.to_string(),
                port.parse::<u16>().unwrap_or(default_port),
            )
        } else {
            (host_port.to_string(), default_port)
        };

        Self {
            host,
            port,
            use_tls,
            websocket,
            url: url.to_string(),
        }
    }

    pub fn is_websocket(&self) -> bool {
        self.websocket
    }

    /// `rumqttc` requires the full URL for WebSocket transports, while raw
    /// MQTT transports accept only a hostname.
    pub fn connection_address(&self) -> &str {
        if self.websocket {
            &self.url
        } else {
            &self.host
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryGuarantee {
    AtMostOnce,
    AtLeastOnce,
    ExactlyOnce,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
    pub delivery: DeliveryGuarantee,
}

/// Transport-agnostic representation of an inbound message.
///
/// MQTT `rumqttc::Publish` sources normalize into this type before being
/// handed to subscriber routing logic. `topic` uses the MQTT slash form
/// (`amux/{team}/...`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingFrame {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retained: bool,
}

pub trait Transport {
    type Error;

    fn publish(
        &self,
        message: TransportMessage,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send;

    fn subscribe(
        &self,
        topic: String,
        delivery: DeliveryGuarantee,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send;
}

impl From<DeliveryGuarantee> for rumqttc::QoS {
    fn from(value: DeliveryGuarantee) -> Self {
        match value {
            DeliveryGuarantee::AtMostOnce => rumqttc::QoS::AtMostOnce,
            DeliveryGuarantee::AtLeastOnce => rumqttc::QoS::AtLeastOnce,
            DeliveryGuarantee::ExactlyOnce => rumqttc::QoS::ExactlyOnce,
        }
    }
}

impl Transport for rumqttc::AsyncClient {
    type Error = rumqttc::ClientError;

    async fn publish(&self, message: TransportMessage) -> Result<(), Self::Error> {
        self.publish(
            message.topic,
            rumqttc::QoS::from(message.delivery),
            message.retain,
            message.payload,
        )
        .await
    }

    async fn subscribe(
        &self,
        topic: String,
        delivery: DeliveryGuarantee,
    ) -> Result<(), Self::Error> {
        self.subscribe(topic, rumqttc::QoS::from(delivery)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mqtt_broker_url_parses_plain_host_and_port() {
        let broker = MqttBroker::parse("mqtt://broker.local:1884");
        assert_eq!(broker.host, "broker.local");
        assert_eq!(broker.port, 1884);
        assert!(!broker.use_tls);
    }

    #[test]
    fn mqtt_broker_url_defaults_ports_by_scheme() {
        let plain = MqttBroker::parse("mqtt://broker.local");
        assert_eq!(plain.port, 1883);
        assert!(!plain.use_tls);

        let tls = MqttBroker::parse("mqtts://broker.local");
        assert_eq!(tls.port, 8883);
        assert!(tls.use_tls);
    }

    #[test]
    fn mqtt_broker_url_matches_legacy_fallback_for_invalid_port() {
        let broker = MqttBroker::parse("mqtts://broker.local:not-a-port");
        assert_eq!(broker.host, "broker.local");
        assert_eq!(broker.port, 8883);
        assert!(broker.use_tls);
    }

    #[test]
    fn mqtt_broker_url_preserves_secure_websocket_endpoint() {
        let broker = MqttBroker::parse("wss://copilot.example.test/mqtt");
        assert_eq!(broker.host, "copilot.example.test");
        assert_eq!(broker.port, 443);
        assert!(broker.use_tls);
        assert!(broker.is_websocket());
        assert_eq!(
            broker.connection_address(),
            "wss://copilot.example.test/mqtt"
        );
    }

    #[test]
    fn delivery_guarantee_maps_to_rumqttc_qos() {
        assert_eq!(
            rumqttc::QoS::AtMostOnce,
            rumqttc::QoS::from(DeliveryGuarantee::AtMostOnce)
        );
        assert_eq!(
            rumqttc::QoS::AtLeastOnce,
            rumqttc::QoS::from(DeliveryGuarantee::AtLeastOnce)
        );
        assert_eq!(
            rumqttc::QoS::ExactlyOnce,
            rumqttc::QoS::from(DeliveryGuarantee::ExactlyOnce)
        );
    }
}
