pub mod client;
pub mod dock_attention;
pub mod tls;
pub mod topics;

pub use client::{ClientConfig, MqttClient};

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

pub struct MqttBusInner {
    pub client: Mutex<Option<MqttClient>>,
    pub subscribed: Mutex<HashSet<String>>,
    /// Packs the current generation and its readiness bit into one atomic.
    /// Keeping them together prevents an obsolete event loop from marking a
    /// newer connection ready between a generation check and a separate store.
    connection_state: AtomicU64,
    /// Linearizes explicit client replacement with outbound enqueue.
    pub(crate) client_gate: RwLock<()>,
    /// Linearizes generation changes with event-loop state/UI side effects.
    /// This is deliberately separate from `client_gate`: a writer waiting for
    /// an in-flight bounded-channel enqueue must not stop the event loop that
    /// drains that channel.
    pub(crate) event_gate: RwLock<()>,
}

impl MqttBusInner {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            subscribed: Mutex::new(HashSet::new()),
            connection_state: AtomicU64::new(0),
            client_gate: RwLock::new(()),
            event_gate: RwLock::new(()),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connection_state.load(Ordering::Acquire) & 1 == 1
    }

    pub fn ready_generation(&self) -> Option<u64> {
        let state = self.connection_state.load(Ordering::Acquire);
        (state & 1 == 1).then_some(state >> 1)
    }

    pub fn current_generation(&self) -> u64 {
        self.connection_state.load(Ordering::Acquire) >> 1
    }

    pub fn bump_generation(&self) -> u64 {
        loop {
            let state = self.connection_state.load(Ordering::Acquire);
            let generation = (state >> 1) + 1;
            let next = generation << 1;
            if self
                .connection_state
                .compare_exchange_weak(state, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return generation;
            }
        }
    }

    /// Updates readiness only if `generation` still owns the connection.
    pub fn set_connected_for_generation(&self, generation: u64, value: bool) -> bool {
        let next = generation << 1 | u64::from(value);
        loop {
            let state = self.connection_state.load(Ordering::Acquire);
            if state >> 1 != generation {
                return false;
            }
            if state == next {
                return true;
            }
            if self
                .connection_state
                .compare_exchange_weak(state, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return true;
            }
        }
    }

    pub async fn force_reconnect(&self) {
        let (generation, client) = {
            let _client_guard = self.client_gate.write().await;
            let _event_guard = self.event_gate.write().await;
            let generation = self.current_generation();
            self.set_connected_for_generation(generation, false);
            let client = self
                .client
                .lock()
                .await
                .as_ref()
                .map(|client| client.client.clone());
            (generation, client)
        };
        if let Some(client) = client {
            // Wait for the active event loop to make bounded-channel capacity,
            // but cancel the enqueue if an explicit connect retires this
            // generation while we wait. No gate is held here, so the event
            // loop remains free to drain requests.
            tokio::select! {
                _ = client.disconnect() => {}
                _ = async {
                    while self.current_generation() == generation {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                } => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MqttBusInner, MqttClient};
    use rumqttc::{AsyncClient, MqttOptions, QoS};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex;

    #[test]
    fn obsolete_generation_cannot_change_new_connection_readiness() {
        let bus = MqttBusInner::new();
        let first = bus.bump_generation();
        assert!(bus.set_connected_for_generation(first, true));
        assert!(bus.is_connected());

        let second = bus.bump_generation();
        assert!(!bus.is_connected());
        assert!(!bus.set_connected_for_generation(first, true));
        assert!(!bus.set_connected_for_generation(first, false));
        assert_eq!(bus.current_generation(), second);
        assert_eq!(bus.ready_generation(), None);

        assert!(bus.set_connected_for_generation(second, true));
        assert_eq!(bus.ready_generation(), Some(second));
    }

    #[tokio::test]
    async fn force_reconnect_stops_waiting_on_a_retired_full_queue() {
        let bus = Arc::new(MqttBusInner::new());
        let generation = bus.bump_generation();
        assert!(bus.set_connected_for_generation(generation, true));

        let options = MqttOptions::new("force-reconnect-test", "127.0.0.1", 1883);
        let (client, event_loop) = AsyncClient::new(options, 1);
        client
            .try_publish("queue/full", QoS::AtLeastOnce, false, vec![1])
            .unwrap();
        *bus.client.lock().await = Some(MqttClient {
            client,
            event_loop: Arc::new(Mutex::new(event_loop)),
            client_id: "force-reconnect-test".to_string(),
        });

        let reconnect = tokio::spawn({
            let bus = bus.clone();
            async move { bus.force_reconnect().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!reconnect.is_finished());

        {
            let _client_guard = bus.client_gate.write().await;
            let _event_guard = bus.event_gate.write().await;
            bus.bump_generation();
        }
        tokio::time::timeout(Duration::from_secs(1), reconnect)
            .await
            .expect("retiring the generation should cancel the blocked disconnect")
            .unwrap();
    }
}

pub type MqttBus = Arc<MqttBusInner>;
