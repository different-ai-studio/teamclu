//! InteractiveQuestion ↔ on-device menu (design §4.4 / plan Phase 3).
//!
//! - Mid-turn `question_asked` → speak prompt + publish `menu` ctl
//! - Device `menu_reply` → resolve option text → answer pending question
//!   or accept as Core inbound (with `[Q:…]` marker)

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::{InboundMessage, InboundSink, InteractiveQuestion};
use teamclu_gateway::esp32::Esp32Driver;
use teamclu_gateway::PendingQuestionStore;
use tokio::sync::oneshot;
use tracing::{info, warn};

use super::adapter::MenuReplyHandler;
use super::esp32_fork::build_esp32_inbound_message;
use crate::config::Esp32Channel;

/// Presents an opencode / pi question on the paired StopWatch.
#[async_trait]
pub trait Esp32QuestionPresenter: Send + Sync {
    /// `binding` is `esp32://{team}/{actor}` from the gateway session.
    async fn present(&self, binding: &str, question: InteractiveQuestion);

    /// Register a oneshot so a later `menu_reply` completes the blocked agent
    /// turn. Default: no-op (present-only stubs).
    fn register_answer_tx(&self, _question_id: String, _tx: oneshot::Sender<String>) {}

    /// Forget a question nobody answered, and take the menu off the screen.
    ///
    /// Without it a question the user walks away from is permanent in three
    /// places at once: the registration, the driver's pending entry, and a
    /// parked task holding an `Arc` of the runtime manager. The device is the
    /// worst of the three — `keepAwake(Screen::Menu)` is true, so a 450 mAh
    /// battery is held on that screen until it is flat.
    async fn withdraw(&self, _question_id: &str) {}
}

/// Bridges driver pending menus ↔ VoiceRouter `menu_reply` ↔ Core inbound.
pub struct Esp32MenuBridge {
    driver: Arc<Esp32Driver>,
    inbound: Arc<dyn InboundSink>,
    pending: Arc<PendingQuestionStore>,
    cfg: Esp32Channel,
    /// Optional oneshot answer path into the runtime (filled when a mid-turn
    /// question is presented). When absent, menu replies fall back to
    /// [`InboundSink::accept`].
    answer_tx_by_qid:
        parking_lot::Mutex<std::collections::HashMap<String, oneshot::Sender<String>>>,
}

impl Esp32MenuBridge {
    pub fn new(driver: Arc<Esp32Driver>, inbound: Arc<dyn InboundSink>, cfg: Esp32Channel) -> Self {
        Self {
            driver,
            inbound,
            pending: Arc::new(PendingQuestionStore::new()),
            cfg,
            answer_tx_by_qid: parking_lot::Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub fn pending_store(&self) -> Arc<PendingQuestionStore> {
        Arc::clone(&self.pending)
    }

    /// Register a oneshot so a later `menu_reply` can complete an in-flight
    /// opencode question without starting a new Core turn.
    pub fn register_answer_tx(&self, question_id: String, tx: oneshot::Sender<String>) {
        self.answer_tx_by_qid.lock().insert(question_id, tx);
    }
}

#[async_trait]
impl Esp32QuestionPresenter for Esp32MenuBridge {
    async fn withdraw(&self, question_id: &str) {
        self.answer_tx_by_qid.lock().remove(question_id);
        // Clears the driver's pending entry and returns whatever `target` it
        // held; `spk_end` is what the firmware turns into `onAgentDone`, which
        // leaves the Menu screen and lets the device sleep again.
        if let Some(target) = self.driver.forget_menu(question_id) {
            let _ = self
                .driver
                .publish_ctl_for(&target, r#"{"from":"amuxd","type":"spk_end"}"#)
                .await;
        }
    }

    async fn present(&self, binding: &str, question: InteractiveQuestion) {
        // binding = "esp32://{team}/{actor}"
        let rest = binding.strip_prefix("esp32://").unwrap_or(binding);
        let mut parts = rest.split('/');
        let team_id = parts.next().unwrap_or("");
        let actor_id = parts.next().unwrap_or("");
        if team_id.is_empty() || actor_id.is_empty() {
            warn!(binding, "esp32 question: malformed binding");
            return;
        }

        let target = match self.driver.last_target_for_actor(actor_id) {
            Some(t) => t,
            None => {
                // First turn on this device may not have delivered yet; build
                // from roster the same way the Core fork does.
                let (device_id, _) = super::esp32_fork::resolve_esp32_device(&self.cfg, actor_id);
                teamclu_gateway::esp32::Esp32Target {
                    team_id: team_id.to_string(),
                    actor_id: actor_id.to_string(),
                    device_id,
                }
            }
        };

        if let Err(e) = self.driver.present_question(&target, &question).await {
            warn!(
                error = %e,
                question_id = %question.question_id,
                "esp32: failed to present question menu"
            );
            return;
        }
        info!(
            question_id = %question.question_id,
            options = question.options.len(),
            "esp32: menu published for interactive question"
        );
    }

    fn register_answer_tx(&self, question_id: String, tx: oneshot::Sender<String>) {
        Esp32MenuBridge::register_answer_tx(self, question_id, tx);
    }
}

#[async_trait]
impl MenuReplyHandler for Esp32MenuBridge {
    async fn on_menu_reply(
        &self,
        team_id: &str,
        actor_id: &str,
        question_id: &str,
        index: usize,
        seq: u64,
        boot_id: Option<&str>,
    ) {
        let Some((target, option_text)) = self.driver.take_menu_option(question_id, index) else {
            warn!(
                team_id,
                actor_id, question_id, index, "menu_reply: no pending menu or index out of range"
            );
            return;
        };

        // Prefer the oneshot registered when the question was presented
        // (answers the blocked agent turn without a new Core accept).
        if let Some(tx) = self.answer_tx_by_qid.lock().remove(question_id) {
            let _ = tx.send(option_text.clone());
            info!(
                question_id,
                index,
                option = %option_text,
                "esp32: menu_reply answered via oneshot"
            );
            return;
        }

        if let Some(entry) = self.pending.take_by_question_id(question_id).await {
            let _ = entry.answer_tx.send(option_text.clone());
            info!(
                question_id,
                index,
                option = %option_text,
                "esp32: menu_reply answered via PendingQuestionStore"
            );
            return;
        }

        // Fallback: treat the selection as a new inbound message (tests /
        // deliver-with-question path without a live agent wait).
        let boot = boot_id.unwrap_or("menu");
        let (_, device_name) = super::esp32_fork::resolve_esp32_device(&self.cfg, actor_id);
        let mut msg: InboundMessage = build_esp32_inbound_message(
            team_id,
            actor_id,
            &target.device_id,
            &device_name,
            boot,
            seq,
            &option_text,
        );
        msg.quoted_text = Some(format!("[Q:{question_id}]"));
        info!(
            question_id,
            index,
            option = %option_text,
            "esp32: menu_reply → Core accept"
        );
        self.inbound.accept(msg).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use teamclu_gateway::driver::{DriverError, TurnEnd};
    use teamclu_gateway::esp32::{Esp32Downlink, Esp32Target};
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct FakeDownlink {
        speaks: Mutex<Vec<String>>,
        ctls: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl Esp32Downlink for FakeDownlink {
        async fn speak(&self, _d: &Esp32Target, text: &str) -> Result<(), DriverError> {
            self.speaks.lock().await.push(text.to_string());
            Ok(())
        }
        async fn speak_delta(
            &self,
            _d: &Esp32Target,
            _turn: &str,
            _t: &str,
        ) -> Result<(), DriverError> {
            Ok(())
        }
        async fn end_turn(
            &self,
            _d: &Esp32Target,
            _turn: &str,
            _e: TurnEnd,
        ) -> Result<(), DriverError> {
            Ok(())
        }
        async fn publish_ctl(&self, _d: &Esp32Target, json: &str) -> Result<(), DriverError> {
            self.ctls.lock().await.push(json.to_string());
            Ok(())
        }
    }

    struct CapturingSink {
        accepted: Mutex<Vec<InboundMessage>>,
    }

    #[async_trait]
    impl InboundSink for CapturingSink {
        async fn accept(&self, msg: InboundMessage) {
            self.accepted.lock().await.push(msg);
        }
    }

    #[tokio::test]
    async fn menu_reply_resolves_option_text_into_inbound() {
        let downlink = Arc::new(FakeDownlink::default());
        let driver = Arc::new(Esp32Driver::new(downlink.clone(), "team-1"));
        let sink = Arc::new(CapturingSink {
            accepted: Mutex::new(Vec::new()),
        });
        let bridge = Esp32MenuBridge::new(
            Arc::clone(&driver),
            sink.clone(),
            Esp32Channel {
                enabled: true,
                devices: vec![],
            },
        );

        let q = InteractiveQuestion {
            question_id: "q-42".into(),
            prompt: "Continue?".into(),
            options: vec!["Yes".into(), "No".into()],
        };
        let target = Esp32Target {
            team_id: "team-1".into(),
            actor_id: "actor-1".into(),
            device_id: "dev-1".into(),
        };
        driver.present_question(&target, &q).await.unwrap();

        bridge
            .on_menu_reply("team-1", "actor-1", "q-42", 1, 7, Some("boot1"))
            .await;

        let accepted = sink.accepted.lock().await;
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].text, "No");
        assert_eq!(accepted[0].quoted_text.as_deref(), Some("[Q:q-42]"));
        assert!(accepted[0]
            .external_message_id
            .starts_with("esp32:dev-1:boot1:7"));
    }

    #[tokio::test]
    async fn menu_reply_oneshot_does_not_accept() {
        let downlink = Arc::new(FakeDownlink::default());
        let driver = Arc::new(Esp32Driver::new(downlink, "team-1"));
        let sink = Arc::new(CapturingSink {
            accepted: Mutex::new(Vec::new()),
        });
        let bridge = Esp32MenuBridge::new(
            Arc::clone(&driver),
            sink.clone(),
            Esp32Channel {
                enabled: true,
                devices: vec![],
            },
        );

        let q = InteractiveQuestion {
            question_id: "q-live".into(),
            prompt: "Pick".into(),
            options: vec!["A".into(), "B".into()],
        };
        let target = Esp32Target {
            team_id: "team-1".into(),
            actor_id: "actor-1".into(),
            device_id: "dev-1".into(),
        };
        driver.present_question(&target, &q).await.unwrap();

        let (tx, rx) = oneshot::channel();
        bridge.register_answer_tx("q-live".into(), tx);

        bridge
            .on_menu_reply("team-1", "actor-1", "q-live", 0, 1, None)
            .await;

        assert_eq!(rx.await.unwrap(), "A");
        assert!(sink.accepted.lock().await.is_empty());
    }
}
