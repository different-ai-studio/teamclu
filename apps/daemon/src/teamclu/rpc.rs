use crate::proto::teamclu::{RpcRequest, RpcResponse};
use prost::Message as ProstMessage;
use std::collections::HashMap;
use std::sync::Arc;
use teamclu_transport::{DeliveryGuarantee, MessagePublisher};
use tokio::sync::oneshot;
use uuid::Uuid;

/// Client-side RPC handler: sends requests and waits for responses via oneshot channels.
#[allow(dead_code)]
pub struct RpcClient {
    pub client: Arc<dyn MessagePublisher>,
    pub team_id: String,
    pub actor_id: String,
    pub pending: HashMap<String, oneshot::Sender<RpcResponse>>,
}

#[allow(dead_code)]
impl RpcClient {
    pub fn new(client: Arc<dyn MessagePublisher>, team_id: String, actor_id: String) -> Self {
        Self {
            client,
            team_id,
            actor_id,
            pending: HashMap::new(),
        }
    }

    /// Sends an RPC request to `target_actor_id` and returns the request id plus
    /// a receiver for the response.
    pub async fn request(
        &mut self,
        target_actor_id: &str,
        mut request: RpcRequest,
    ) -> crate::error::Result<(String, oneshot::Receiver<RpcResponse>)> {
        let request_id = Self::new_request_id();
        request.request_id = request_id.clone();
        let topic = format!("amux/{}/{}/rpc/req", self.team_id, target_actor_id);
        let payload = request.encode_to_vec();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id.clone(), tx);
        self.client
            .publish(&topic, payload, false, DeliveryGuarantee::AtLeastOnce)
            .await?;
        Ok((request_id, rx))
    }

    /// Handles an incoming response topic+payload. Returns `true` if it matched a pending request.
    ///
    /// Expected topic format: `amux/{teamId}/{actorId}/rpc/res`
    pub fn handle_response(&mut self, topic: &str, payload: &[u8]) -> bool {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {teamId} / {actorId} / rpc / res
        if parts.len() != 5 {
            return false;
        }
        if parts[0] != "amux" || parts[3] != "rpc" || parts[4] != "res" {
            return false;
        }
        if let Ok(response) = RpcResponse::decode(payload) {
            let request_id = response.request_id.as_str();
            if let Some(tx) = self.pending.remove(request_id) {
                let _ = tx.send(response);
                return true;
            }
        }
        false
    }

    /// Generates a unique request ID for RPC correlation.
    pub fn new_request_id() -> String {
        Uuid::new_v4().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_handle_response_valid() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (client, _eventloop) =
                rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
            let mut rpc_client = RpcClient::new(
                Arc::new(client) as Arc<dyn MessagePublisher>,
                "team1".to_string(),
                "actor-a".to_string(),
            );

            // Manually insert a pending request
            let (tx, rx) = oneshot::channel();
            rpc_client.pending.insert("req123".to_string(), tx);

            let response = RpcResponse {
                request_id: "req123".to_string(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                result: None,
            };
            let payload = response.encode_to_vec();
            let topic = "amux/team1/actor-a/rpc/res";

            let matched = rpc_client.handle_response(topic, &payload);
            assert!(matched);
            assert!(rpc_client.pending.is_empty());

            let received = rx.await.unwrap();
            assert!(received.success);
        });
    }

    #[test]
    fn test_handle_response_no_pending() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (client, _eventloop) =
                rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
            let mut rpc_client = RpcClient::new(
                Arc::new(client) as Arc<dyn MessagePublisher>,
                "team1".to_string(),
                "actor-a".to_string(),
            );

            let response = RpcResponse {
                request_id: "req999".to_string(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                result: None,
            };
            let payload = response.encode_to_vec();
            let topic = "amux/team1/actor-a/rpc/res";

            let matched = rpc_client.handle_response(topic, &payload);
            assert!(!matched); // no pending request
        });
    }

    #[test]
    fn test_handle_response_wrong_topic() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (client, _eventloop) =
                rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
            let mut rpc_client = RpcClient::new(
                Arc::new(client) as Arc<dyn MessagePublisher>,
                "team1".to_string(),
                "actor-a".to_string(),
            );
            let matched = rpc_client.handle_response("bad/topic", &[]);
            assert!(!matched);
        });
    }

    #[test]
    fn test_new_request_id_is_full_uuid() {
        let id = RpcClient::new_request_id();
        assert_eq!(id.len(), 36);
        assert!(id.contains('-'));
    }
}
