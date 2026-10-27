//! Round trip against a real iPad-protocol server and a logged-in account.
//!
//! Ignored by default — it sends a real WeChat message and waits for a human
//! to answer. Run it with the server up (`deploy/wechatpad/docker-compose.yml`)
//! and nothing else on the callback port:
//!
//! ```sh
//! WECHATPAD_E2E_ACCOUNT=wxid_bot WECHATPAD_E2E_PEER=wxid_you \
//!   cargo test -p teamclu-gateway --test wechatpad_live -- --ignored --nocapture
//! ```
//!
//! Then reply to the message the account sends you. It waits
//! `WECHATPAD_E2E_WAIT_SECS` (default 600) for that reply.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use teamclu_gateway::driver::{
    ChannelDriver, Conversation, ConversationKind, InboundMessage, InboundSink, OutboundMessage,
};
use teamclu_gateway::{WeChatPadConfig, WeChatPadGateway};

struct Collect(Mutex<Vec<InboundMessage>>);

#[async_trait::async_trait]
impl InboundSink for Collect {
    async fn accept(&self, msg: InboundMessage) {
        self.0.lock().unwrap().push(msg);
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a live protocol server, a logged-in account and a human"]
async fn a_message_goes_out_and_the_answer_comes_back() {
    let account = std::env::var("WECHATPAD_E2E_ACCOUNT").expect("WECHATPAD_E2E_ACCOUNT");
    let peer = std::env::var("WECHATPAD_E2E_PEER").expect("WECHATPAD_E2E_PEER");

    let mut gw = WeChatPadGateway::new();
    gw.set_config(WeChatPadConfig {
        enabled: true,
        account_wxid: account.clone(),
        allow_from: vec![peer.clone()],
        ..WeChatPadConfig::default()
    })
    .await;
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    gw.use_core_pipeline(sink.clone()).await;
    gw.start().await.expect("start");
    let driver = gw.as_driver().await;

    // Attached?
    for _ in 0..50 {
        if gw.get_status().await.status == teamclu_gateway::WeChatPadGatewayStatus::Connected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let status = gw.get_status().await;
    assert_eq!(
        status.status,
        teamclu_gateway::WeChatPadGatewayStatus::Connected,
        "attach failed: {:?}",
        status.error_message
    );

    let to = Conversation {
        channel: "wechatpad",
        bot_id: Some(account.clone()),
        kind: ConversationKind::Direct,
        id: peer.clone(),
    };
    driver
        .deliver(
            &to,
            Some("e2e"),
            &OutboundMessage {
                text: "wechatpad e2e：teamclu 驱动发出的测试消息，回复任意内容即可。".into(),
                ..Default::default()
            },
        )
        .await
        .expect("send");
    let wait_secs: u64 = std::env::var("WECHATPAD_E2E_WAIT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    println!("sent; waiting up to {wait_secs}s for a reply from {peer}…");

    let mut reply = None;
    for _ in 0..wait_secs * 10 {
        if let Some(m) = sink.0.lock().unwrap().first() {
            reply = Some((
                m.text.clone(),
                m.sender.external_id.clone(),
                m.sender.display_name.clone(),
                m.external_message_id.clone(),
                m.addressed_to_bot,
            ));
        }
        if reply.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    gw.shutdown().await;

    let (text, sender, name, id, addressed) = reply.expect("no reply arrived");
    println!("received {text:?} from {sender} ({name}), id {id}, addressed {addressed}");
    assert_eq!(sender, peer);
    assert!(addressed);
}
