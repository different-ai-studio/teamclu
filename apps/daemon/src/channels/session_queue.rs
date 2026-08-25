use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

const MAX_QUEUE_SIZE: usize = 5;
/// Default patience for a message that has been waiting its turn. Channels
/// override it: it has to be at least as long as one of their turns, or a
/// message queued behind a perfectly healthy 10-minute turn is dropped for
/// being "late".
const MESSAGE_TIMEOUT: Duration = Duration::from_secs(180);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

type QueueFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type RejectNotifyFn = Box<dyn FnOnce(RejectReason) -> QueueFuture + Send>;

pub enum RejectReason {
    Timeout,
    QueueFull,
    SessionClosed,
}

pub enum EnqueueResult {
    Processing,
    Queued { position: usize },
    Full,
}

pub struct QueuedMessage {
    pub enqueued_at: Instant,
    pub process_fn: Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>,
    pub notify_fn: Option<RejectNotifyFn>,
}

struct SessionQueueState {
    tx: mpsc::Sender<QueuedMessage>,
    pending_count: Arc<AtomicUsize>,
}

pub struct SessionQueue {
    queues: Arc<RwLock<HashMap<String, SessionQueueState>>>,
    message_timeout: Duration,
}

impl SessionQueue {
    pub fn new() -> Self {
        Self::with_message_timeout(MESSAGE_TIMEOUT)
    }

    /// A queue whose waiting messages are given `message_timeout` before they
    /// are dropped as stale. Pass the channel's own turn timeout: waiting one
    /// full turn is normal, waiting several means nobody is coming.
    pub fn with_message_timeout(message_timeout: Duration) -> Self {
        Self {
            queues: Arc::new(RwLock::new(HashMap::new())),
            message_timeout,
        }
    }

    pub async fn enqueue(&self, session_key: &str, msg: QueuedMessage) -> EnqueueResult {
        let mut queues = self.queues.write().await;

        if let Some(state) = queues.get(session_key) {
            match state.tx.try_send(msg) {
                Ok(_) => {
                    // fetch_add returns old value. With init=1 (first msg being processed),
                    // second msg gets pos=1, third gets pos=2, etc. 1-based queue position.
                    let ahead = state.pending_count.fetch_add(1, Ordering::Relaxed);
                    // Zero ahead means the consumer is parked on `recv` with
                    // nothing in flight — this message is picked up now, not
                    // queued. The chat was being told "0 messages ahead of
                    // you", which is a wait that is not happening.
                    if ahead == 0 {
                        return EnqueueResult::Processing;
                    }
                    return EnqueueResult::Queued { position: ahead };
                }
                Err(mpsc::error::TrySendError::Closed(returned_msg)) => {
                    queues.remove(session_key);
                    return Self::create_and_send(
                        &mut queues,
                        session_key,
                        returned_msg,
                        &self.queues,
                        self.message_timeout,
                    );
                }
                Err(mpsc::error::TrySendError::Full(mut returned_msg)) => {
                    if let Some(notify) = returned_msg.notify_fn.take() {
                        tokio::spawn(notify(RejectReason::QueueFull));
                    }
                    return EnqueueResult::Full;
                }
            }
        }

        Self::create_and_send(
            &mut queues,
            session_key,
            msg,
            &self.queues,
            self.message_timeout,
        )
    }

    fn create_and_send(
        queues: &mut HashMap<String, SessionQueueState>,
        session_key: &str,
        msg: QueuedMessage,
        queues_arc: &Arc<RwLock<HashMap<String, SessionQueueState>>>,
        message_timeout: Duration,
    ) -> EnqueueResult {
        let (tx, rx) = mpsc::channel(MAX_QUEUE_SIZE);
        // Init to 1: the first message is in the channel, being consumed.
        // enqueue uses fetch_add(1) as the 1-based position.
        let pending_count = Arc::new(AtomicUsize::new(1));

        let _ = tx.try_send(msg);

        queues.insert(
            session_key.to_string(),
            SessionQueueState {
                tx,
                pending_count: Arc::clone(&pending_count),
            },
        );

        spawn_consumer(
            session_key.to_string(),
            rx,
            pending_count,
            Arc::clone(queues_arc),
            message_timeout,
        );

        EnqueueResult::Processing
    }

    pub async fn shutdown(&self) {
        let mut queues = self.queues.write().await;
        queues.clear();
        println!("[SessionQueue] All queues shut down");
    }
}

impl Default for SessionQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_consumer(
    session_key: String,
    mut rx: mpsc::Receiver<QueuedMessage>,
    pending_count: Arc<AtomicUsize>,
    queues: Arc<RwLock<HashMap<String, SessionQueueState>>>,
    message_timeout: Duration,
) {
    tokio::spawn(async move {
        loop {
            match tokio::time::timeout(IDLE_TIMEOUT, rx.recv()).await {
                Ok(Some(msg)) => {
                    if msg.enqueued_at.elapsed() > message_timeout {
                        if let Some(notify) = msg.notify_fn {
                            let _ = notify(RejectReason::Timeout).await;
                        }
                    } else {
                        (msg.process_fn)().await;
                    }
                    pending_count.fetch_sub(1, Ordering::Relaxed);
                }
                Ok(None) => break,
                Err(_) => {
                    rx.close();
                    break;
                }
            }
        }

        while let Ok(msg) = rx.try_recv() {
            if let Some(notify) = msg.notify_fn {
                let _ = notify(RejectReason::SessionClosed).await;
            }
            pending_count.fetch_sub(1, Ordering::Relaxed);
        }

        let mut queues = queues.write().await;
        queues.remove(&session_key);
        println!(
            "[SessionQueue] Consumer for '{}' exited and cleaned up",
            session_key
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn make_msg(processed: Arc<AtomicBool>) -> QueuedMessage {
        QueuedMessage {
            enqueued_at: Instant::now(),
            process_fn: Box::new(move || {
                Box::pin(async move {
                    processed.store(true, Ordering::Relaxed);
                })
            }),
            notify_fn: None,
        }
    }

    #[tokio::test]
    async fn a_channel_can_outlast_the_default_patience() {
        // A 10-minute WeCom turn must not make the message behind it "late":
        // the queue's patience comes from the channel, not from this file.
        let queue = SessionQueue::with_message_timeout(Duration::from_secs(600));
        let processed = Arc::new(AtomicBool::new(false));
        let mut msg = make_msg(Arc::clone(&processed));
        // Enqueued four minutes ago — stale under the 180s default, fine here.
        msg.enqueued_at = Instant::now() - Duration::from_secs(240);
        queue.enqueue("s-long", msg).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            processed.load(Ordering::Relaxed),
            "message dropped despite the channel allowing a longer wait"
        );
    }

    #[tokio::test]
    async fn test_first_enqueue_returns_processing() {
        let queue = SessionQueue::new();
        let processed = Arc::new(AtomicBool::new(false));
        let result = queue
            .enqueue("test:session1", make_msg(processed.clone()))
            .await;
        assert!(matches!(result, EnqueueResult::Processing));
    }

    #[tokio::test]
    async fn test_second_enqueue_returns_queued() {
        let queue = SessionQueue::new();

        // First message: starts a slow consumer
        let msg1 = QueuedMessage {
            enqueued_at: Instant::now(),
            process_fn: Box::new(|| {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                })
            }),
            notify_fn: None,
        };
        let r1 = queue.enqueue("s1", msg1).await;
        assert!(matches!(r1, EnqueueResult::Processing));

        // Second message: should be queued at position 1
        let processed = Arc::new(AtomicBool::new(false));
        let r2 = queue.enqueue("s1", make_msg(processed.clone())).await;
        assert!(matches!(r2, EnqueueResult::Queued { position: 1 }));
    }

    #[tokio::test]
    async fn an_idle_conversation_is_processing_not_queued() {
        // The consumer outlives the message it just finished, so a second
        // message arriving into a quiet chat reuses that queue. It is not
        // waiting for anything, and saying so told the user "0 ahead of you".
        let queue = SessionQueue::new();
        let first = Arc::new(AtomicBool::new(false));
        queue.enqueue("s-idle", make_msg(Arc::clone(&first))).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(first.load(Ordering::Relaxed), "the first message ran");

        let second = Arc::new(AtomicBool::new(false));
        let result = queue.enqueue("s-idle", make_msg(second)).await;
        assert!(
            matches!(result, EnqueueResult::Processing),
            "nothing was ahead of it"
        );
    }

    #[tokio::test]
    async fn test_queue_full_after_max() {
        let queue = SessionQueue::new();
        let notified = Arc::new(AtomicBool::new(false));

        // First message: block the consumer
        let msg1 = QueuedMessage {
            enqueued_at: Instant::now(),
            process_fn: Box::new(|| {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                })
            }),
            notify_fn: None,
        };
        queue.enqueue("s1", msg1).await;

        // Let consumer start and pick up msg1 from the channel buffer
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Fill the queue (5 more = channel capacity)
        for _ in 0..MAX_QUEUE_SIZE {
            let r = queue
                .enqueue(
                    "s1",
                    QueuedMessage {
                        enqueued_at: Instant::now(),
                        process_fn: Box::new(|| Box::pin(async {})),
                        notify_fn: None,
                    },
                )
                .await;
            assert!(matches!(r, EnqueueResult::Queued { .. }));
        }

        // Next one should be Full
        let notified_clone = notified.clone();
        let r = queue
            .enqueue(
                "s1",
                QueuedMessage {
                    enqueued_at: Instant::now(),
                    process_fn: Box::new(|| Box::pin(async {})),
                    notify_fn: Some(Box::new(move |_reason| {
                        let n = notified_clone;
                        Box::pin(async move {
                            n.store(true, Ordering::Relaxed);
                        })
                    })),
                },
            )
            .await;
        assert!(matches!(r, EnqueueResult::Full));

        // Give spawned notify task time to run
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(notified.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn test_serial_processing_order() {
        let queue = SessionQueue::new();
        let order = Arc::new(tokio::sync::Mutex::new(Vec::<u32>::new()));

        for i in 0..3 {
            let order_clone = Arc::clone(&order);
            let msg = QueuedMessage {
                enqueued_at: Instant::now(),
                process_fn: Box::new(move || {
                    Box::pin(async move {
                        order_clone.lock().await.push(i);
                    })
                }),
                notify_fn: None,
            };
            queue.enqueue("s1", msg).await;
        }

        // Wait for consumer to process all messages
        tokio::time::sleep(Duration::from_millis(200)).await;
        let result = order.lock().await;
        assert_eq!(*result, vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn test_timeout_skips_message() {
        let queue = SessionQueue::new();
        let processed = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));

        let timed_out_clone = timed_out.clone();
        let processed_clone = processed.clone();
        // Create a message with enqueued_at in the distant past
        let msg = QueuedMessage {
            enqueued_at: Instant::now() - Duration::from_secs(200), // > MESSAGE_TIMEOUT
            process_fn: Box::new(move || {
                let p = processed_clone;
                Box::pin(async move {
                    p.store(true, Ordering::Relaxed);
                })
            }),
            notify_fn: Some(Box::new(move |_reason| {
                let t = timed_out_clone;
                Box::pin(async move {
                    t.store(true, Ordering::Relaxed);
                })
            })),
        };

        queue.enqueue("s1", msg).await;

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !processed.load(Ordering::Relaxed),
            "timed-out message should not be processed"
        );
        assert!(
            timed_out.load(Ordering::Relaxed),
            "notify_fn should have been called"
        );
    }

    #[tokio::test]
    async fn test_different_sessions_independent() {
        let queue = SessionQueue::new();
        let p1 = Arc::new(AtomicBool::new(false));
        let p2 = Arc::new(AtomicBool::new(false));

        let r1 = queue.enqueue("session_a", make_msg(p1.clone())).await;
        let r2 = queue.enqueue("session_b", make_msg(p2.clone())).await;

        // Both should be Processing (not Queued), since they are different sessions
        assert!(matches!(r1, EnqueueResult::Processing));
        assert!(matches!(r2, EnqueueResult::Processing));

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(p1.load(Ordering::Relaxed));
        assert!(p2.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn test_shutdown_clears_queues() {
        let queue = SessionQueue::new();

        // Block consumer with slow message
        let msg = QueuedMessage {
            enqueued_at: Instant::now(),
            process_fn: Box::new(|| {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                })
            }),
            notify_fn: None,
        };
        queue.enqueue("s1", msg).await;

        // Shutdown
        queue.shutdown().await;

        // Next enqueue should create a fresh consumer (Processing, not Queued)
        let processed = Arc::new(AtomicBool::new(false));
        let r = queue.enqueue("s1", make_msg(processed.clone())).await;
        assert!(matches!(r, EnqueueResult::Processing));

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(processed.load(Ordering::Relaxed));
    }
}
