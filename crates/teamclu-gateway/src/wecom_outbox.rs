//! In-memory outbox for WeCom proactive sends that failed while the
//! websocket was down. Flushed after a successful subscribe.
//!
//! Process crash is intentionally not covered: `write_reply` already
//! persisted the session, so the user can read the answer in the app.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSend {
    pub chatid: String,
    pub chat_type: u32,
    pub text: String,
    pub retry_count: u32,
}

#[derive(Clone, Default)]
pub struct WeComOutbox {
    inner: Arc<Mutex<VecDeque<PendingSend>>>,
}

impl WeComOutbox {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enqueue(&self, item: PendingSend) {
        self.inner
            .lock()
            .expect("wecom outbox mutex")
            .push_back(item);
    }

    pub fn drain(&self) -> Vec<PendingSend> {
        self.inner
            .lock()
            .expect("wecom outbox mutex")
            .drain(..)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("wecom outbox mutex").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_preserves_order_and_drain_clears() {
        let box_ = WeComOutbox::new();
        box_.enqueue(PendingSend {
            chatid: "a".into(),
            chat_type: 1,
            text: "one".into(),
            retry_count: 0,
        });
        box_.enqueue(PendingSend {
            chatid: "b".into(),
            chat_type: 2,
            text: "two".into(),
            retry_count: 1,
        });
        assert_eq!(box_.len(), 2);
        let items = box_.drain();
        assert_eq!(items[0].chatid, "a");
        assert_eq!(items[1].text, "two");
        assert!(box_.is_empty());
    }

    #[test]
    fn drain_of_empty_is_empty() {
        let box_ = WeComOutbox::new();
        assert!(box_.drain().is_empty());
    }
}
