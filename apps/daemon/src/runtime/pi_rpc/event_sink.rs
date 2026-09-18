//! A session's way into its runtime handle, which the stdout reader can never
//! block on.
//!
//! One reader serves every session in a pi child, and it reads request
//! responses on the same loop as events. It used to hand each event straight
//! to the handle's bounded channel and wait for room, so a single session
//! whose events nobody was draining stopped the reader for the whole child:
//! `open_session`, `close_session`, `set_model` — every response sat unread
//! until its 30s request timeout. On 2026-09-16 that froze a host for 42
//! minutes: three sessions were draining offline messages, the daemon's run
//! loop (which polls events) was busy with back-to-back RuntimeStarts that were
//! themselves waiting on those responses, and nothing moved until the idle
//! sweeper finally dropped the three.
//!
//! The sink puts an unbounded queue in front of the handle's channel and a
//! forwarder task behind it. The reader's order of processing is unchanged —
//! route state still updates in stream order, and responses still resolve
//! after the events before them — only delivery to the consumer is decoupled.
//! A consumer that stops draining now costs memory, not the host, and says so
//! in the log.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;
use tracing::warn;

use crate::runtime::acp_event_frame::AcpEventFrame;

/// Backlog at which the log first says a consumer is not draining; it says
/// so again at every doubling.
const BACKLOG_WARN_AT: usize = 1024;

#[derive(Clone)]
pub(crate) struct EventSink {
    tx: mpsc::UnboundedSender<AcpEventFrame>,
    backlog: Arc<AtomicUsize>,
}

impl EventSink {
    /// Forward into `handle_tx`, in order, until either side goes away.
    pub(crate) fn forward_to(handle_tx: mpsc::Sender<AcpEventFrame>) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<AcpEventFrame>();
        let backlog = Arc::new(AtomicUsize::new(0));
        let depth = backlog.clone();
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                depth.fetch_sub(1, Ordering::Relaxed);
                if handle_tx.send(frame).await.is_err() {
                    // The runtime is gone; what is left has nowhere to go.
                    break;
                }
            }
        });
        Self { tx, backlog }
    }

    /// A sink whose queue the test reads directly, with no forwarder in
    /// between — delivery stays synchronous, so `try_recv` right after an
    /// event means what it meant before.
    #[cfg(test)]
    pub(crate) fn capture() -> (Self, mpsc::UnboundedReceiver<AcpEventFrame>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                tx,
                backlog: Arc::new(AtomicUsize::new(0)),
            },
            rx,
        )
    }

    /// Queue a frame. Never waits on the consumer; async only so call sites
    /// read like the channel send they replaced.
    pub(crate) async fn send(
        &self,
        frame: AcpEventFrame,
    ) -> Result<(), mpsc::error::SendError<AcpEventFrame>> {
        let depth = self.backlog.fetch_add(1, Ordering::Relaxed) + 1;
        if depth >= BACKLOG_WARN_AT && depth.is_power_of_two() {
            warn!(
                session_id = %frame.acp_session_id,
                backlog = depth,
                "pi events are backing up: the runtime is not draining them"
            );
        }
        self.tx.send(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn frame(n: usize) -> AcpEventFrame {
        AcpEventFrame::new(
            "pi:/s.jsonl",
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                    text: n.to_string(),
                    is_complete: false,
                })),
                model: String::new(),
            },
        )
    }

    fn text(f: &AcpEventFrame) -> String {
        match &f.event.event {
            Some(amux::acp_event::Event::Output(o)) => o.text.clone(),
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_consumer_that_is_not_draining_never_blocks_the_sender() {
        // One slot, nobody reading: the old direct send parked on the second
        // frame, and with it the reader for every session in the child.
        let (handle_tx, mut handle_rx) = mpsc::channel(1);
        let sink = EventSink::forward_to(handle_tx);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            for n in 0..5_000 {
                let _ = sink.send(frame(n)).await;
            }
        })
        .await
        .expect("queueing must not wait for the consumer");

        // Once the consumer catches up it gets everything, in order.
        for n in 0..5_000 {
            let got = handle_rx.recv().await.expect("frame");
            assert_eq!(text(&got), n.to_string());
        }
    }

    #[tokio::test]
    async fn a_gone_runtime_stops_the_forwarder_without_failing_the_sender() {
        let (handle_tx, handle_rx) = mpsc::channel(1);
        let sink = EventSink::forward_to(handle_tx);
        drop(handle_rx);
        for n in 0..10 {
            let _ = sink.send(frame(n)).await;
        }
        tokio::task::yield_now().await;
    }
}
