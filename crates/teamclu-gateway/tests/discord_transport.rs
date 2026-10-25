//! Compatibility check for the patched Serenity websocket transport; no Discord account.
use futures_util::StreamExt;
use serenity::gateway::Shard;
use serenity::model::gateway::{GatewayIntents, ShardInfo};
use serenity::model::id::ShardId;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[tokio::test]
async fn serenity_connects_and_sends_identify_and_heartbeat_over_websocket() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = tokio_tungstenite::accept_hdr_async(stream, |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                assert_eq!(request.uri().path(), "/gateway");
                assert!(request.uri().query().unwrap().contains("v="));
                Ok(response)
            }).await.unwrap();
            let identify = websocket.next().await.unwrap().unwrap();
            let identify: serde_json::Value = serde_json::from_str(identify.to_text().unwrap()).unwrap();
            assert_eq!(identify["op"], 2);
            assert_eq!(identify["d"]["token"], "local-test-token");
            let heartbeat = websocket.next().await.unwrap().unwrap();
            let heartbeat: serde_json::Value = serde_json::from_str(heartbeat.to_text().unwrap()).unwrap();
            assert_eq!(heartbeat["op"], 1);
            assert_eq!(heartbeat["d"], 0);
        });
        let mut shard = Shard::new(Arc::new(Mutex::new(format!("ws://{address}/gateway"))), "local-test-token", ShardInfo { id: ShardId(0), total: 1 }, GatewayIntents::empty(), None).await.unwrap();
        shard.identify().await.unwrap();
        shard.heartbeat().await.unwrap();
        server.await.unwrap();
    }).await.unwrap();
}
