//! MQTT connection supervision.
//!
//! The important ownership rule in this module is that `EventLoop` and
//! `AsyncClient` never escape the worker task.  Business code only sees the
//! stable `MqttPublisher` proxy, so a reconnect cannot leave a
//! `SessionManager` or `LivePublisher` holding a dead client generation.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use rumqttc::{Event, Outgoing, Packet, QoS};
use teamclu_transport::{DeliveryGuarantee, IncomingFrame, MessagePublisher, PublisherError};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::backend::{proactive_reconnect_delay, Backend};
use crate::config::DaemonConfig;
use crate::mqtt::subscriber;
use crate::mqtt::MqttClient;

use super::durable_queue::{DurableMqttStore, DurablePublish, StoredDelivery};

const COMMAND_CAPACITY: usize = 2048;
const INBOUND_CAPACITY: usize = 2048;
const INBOUND_STAGING_CAPACITY: usize = 4096;
const DURABLE_QUEUE_CAPACITY: usize = 4096;
const DURABLE_QUEUE_MAX_BYTES: usize = 64 * 1024 * 1024;
const RECOVERY_DEADLINE: Duration = Duration::from_secs(30);
const REBUILD_RETRY: Duration = Duration::from_secs(5);
const REBUILD_RETRY_MAX: Duration = Duration::from_secs(30);
const SUPERVISOR_TICK: Duration = Duration::from_secs(1);
const WORKER_STALL_WARN: Duration = Duration::from_secs(5);
const POLL_PENDING_WARN: Duration = Duration::from_secs(45);
const POLL_PENDING_REBUILD: Duration = Duration::from_secs(75);
const CONTROL_CAPACITY: usize = 32;
const WORKER_COMMAND_CAPACITY: usize = 2048;
const WORKER_DISPOSITION_CAPACITY: usize = 2048;
const WORKER_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const RECOVERY_SIGNAL_TIMEOUT: Duration = Duration::from_secs(2);
const WAKE_GAP_THRESHOLD: Duration = Duration::from_secs(120);
const INBOUND_RETRY_MAX: Duration = Duration::from_secs(30);
const DURABLE_STORE_FAILURE_PREFIX: &str = "durable_store:";

/// Tracked MQTT subscription restored after every CONNACK.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrackedSubscription {
    qos: QoS,
    /// When true, SUBACK Failure / restore queue errors warn once and never
    /// force a worker rebuild (ACL migration lag for `sync/+`).
    optional: bool,
}

/// Decision after a SUBACK Failure (or restore `try_subscribe` queue reject).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubackFailureAction {
    /// Required topic — schedule `forced_rebuild` during auto-restore.
    ForceRebuild,
    /// Optional topic — warn once, keep the worker.
    Tolerate,
}

fn suback_failure_action(optional: bool) -> SubackFailureAction {
    if optional {
        SubackFailureAction::Tolerate
    } else {
        SubackFailureAction::ForceRebuild
    }
}

fn warn_optional_subscribe_rejected(topic: &str) {
    static WARNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let set = WARNED.get_or_init(|| Mutex::new(HashSet::new()));
    let mut guard = set.lock().unwrap_or_else(|e| e.into_inner());
    if guard.insert(topic.to_string()) {
        warn!(
            topic,
            "optional MQTT subscription rejected by broker; will retry on next reconnect"
        );
    }
}

/// The one snapshot published to `/v1/info`. Keeping the fields together
/// prevents the UI from observing `connected=true` with a stale recovery phase.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MqttSnapshot {
    pub snapshot_version: u64,
    pub connected: bool,
    pub phase: String,
    pub worker_generation: Option<u64>,
    pub connection_attempt: Option<u64>,
    pub ready_generation: Option<u64>,
    pub last_error_code: Option<String>,
    pub last_error_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_recovery_reason: Option<String>,
    pub next_retry_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_ready_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub type MqttSnapshotHandle = Arc<parking_lot::RwLock<MqttSnapshot>>;

impl Default for MqttSnapshot {
    fn default() -> Self {
        Self {
            snapshot_version: 0,
            connected: false,
            phase: "Starting".to_string(),
            worker_generation: None,
            connection_attempt: None,
            ready_generation: None,
            last_error_code: None,
            last_error_at: None,
            last_recovery_reason: None,
            next_retry_at: None,
            last_ready_at: None,
        }
    }
}

fn snapshot_update(snapshot: &MqttSnapshotHandle, update: impl FnOnce(&mut MqttSnapshot)) {
    let mut current = snapshot.write();
    update(&mut current);
    current.snapshot_version = current.snapshot_version.wrapping_add(1);
}

fn mqtt_error_code(reason: &str) -> &'static str {
    let reason = reason.to_ascii_lowercase();
    if reason.contains("dns") || reason.contains("resolve") {
        "dns_failure"
    } else if reason.contains("tls") || reason.contains("certificate") {
        "tls_failure"
    } else if reason.contains("not authorized")
        || reason.contains("bad username")
        || reason.contains("authentication")
    {
        "broker_auth_rejected"
    } else if reason.contains("timeout") || reason.contains("timed out") {
        "network_timeout"
    } else if reason.contains("502") || reason.contains("503") {
        "broker_unavailable"
    } else if reason.contains("closed") || reason.contains("eof") {
        "connection_closed"
    } else {
        "transport_failure"
    }
}

fn should_persist_publish(delivery: &DeliveryGuarantee) -> bool {
    !matches!(delivery, DeliveryGuarantee::AtMostOnce)
}

fn is_durable_store_failure(reason: &str) -> bool {
    reason.starts_with(DURABLE_STORE_FAILURE_PREFIX)
}

fn recovery_may_retry_storage(reason: MqttRecoveryReason) -> bool {
    matches!(reason, MqttRecoveryReason::UserRequested)
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MqttRecoveryReason {
    Startup,
    VisibilityResume,
    LongVisibilityResume,
    NetworkOnline,
    UserRequested,
    Watchdog,
    CredentialRejected,
}

impl MqttRecoveryReason {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "startup" => Some(Self::Startup),
            "visibility_resume" => Some(Self::VisibilityResume),
            "long_visibility_resume" => Some(Self::LongVisibilityResume),
            "network_online" => Some(Self::NetworkOnline),
            "user_requested" => Some(Self::UserRequested),
            "watchdog" => Some(Self::Watchdog),
            "credential_rejected" => Some(Self::CredentialRejected),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::VisibilityResume => "visibility_resume",
            Self::LongVisibilityResume => "long_visibility_resume",
            Self::NetworkOnline => "network_online",
            Self::UserRequested => "user_requested",
            Self::Watchdog => "watchdog",
            Self::CredentialRejected => "credential_rejected",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MqttRecoveryOutcome {
    Recovering,
    AlreadyHealthy,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MqttRecoveryAccepted {
    pub accepted: bool,
    pub outcome: MqttRecoveryOutcome,
    pub request_id: String,
    pub worker_generation: Option<u64>,
}

#[derive(Debug)]
pub enum MqttRecoveryError {
    Unavailable,
    Timeout,
}

pub struct MqttRecoveryRequest {
    pub reason: MqttRecoveryReason,
    pub request_id: String,
    pub reply: oneshot::Sender<MqttRecoveryAccepted>,
    coalescing: Arc<AtomicBool>,
}

/// A bounded recovery signal with sender-side coalescing. The HTTP layer can be
/// started before the supervisor, so the receiver is attached later by
/// `spawn`. Concurrent focus/online/wake signals share one recovery edge and
/// do not turn a healthy request queue into a spurious HTTP 503.
#[derive(Debug, Clone)]
pub struct MqttRecoveryHandle {
    tx: mpsc::Sender<MqttRecoveryRequest>,
    next_request_id: Arc<AtomicU64>,
    coalescing: Arc<AtomicBool>,
}

impl MqttRecoveryHandle {
    pub fn channel() -> (Self, mpsc::Receiver<MqttRecoveryRequest>) {
        let (tx, rx) = mpsc::channel(1);
        (
            Self {
                tx,
                next_request_id: Arc::new(AtomicU64::new(1)),
                coalescing: Arc::new(AtomicBool::new(false)),
            },
            rx,
        )
    }

    pub async fn request(
        &self,
        reason: MqttRecoveryReason,
    ) -> Result<MqttRecoveryAccepted, MqttRecoveryError> {
        let request_id = format!(
            "mqtt-recovery-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        if self.coalescing.swap(true, Ordering::AcqRel) {
            return Ok(MqttRecoveryAccepted {
                accepted: true,
                outcome: MqttRecoveryOutcome::Recovering,
                request_id,
                worker_generation: None,
            });
        }
        let (reply, response) = oneshot::channel();
        if self
            .tx
            .try_send(MqttRecoveryRequest {
                reason,
                request_id,
                reply,
                coalescing: self.coalescing.clone(),
            })
            .is_err()
        {
            self.coalescing.store(false, Ordering::Release);
            return Err(MqttRecoveryError::Unavailable);
        }
        let result = tokio::time::timeout(RECOVERY_SIGNAL_TIMEOUT, response)
            .await
            .map_err(|_| MqttRecoveryError::Timeout)
            .and_then(|result| result.map_err(|_| MqttRecoveryError::Unavailable));
        match &result {
            Ok(accepted) if matches!(accepted.outcome, MqttRecoveryOutcome::AlreadyHealthy) => {
                self.coalescing.store(false, Ordering::Release);
            }
            Ok(accepted) if !accepted.accepted => {
                self.coalescing.store(false, Ordering::Release);
            }
            Err(_) => {
                self.coalescing.store(false, Ordering::Release);
            }
            _ => {}
        }
        result
    }
}

/// Commands accepted by the stable publisher proxy.
pub enum MqttCommand {
    Publish {
        topic: String,
        payload: Vec<u8>,
        retain: bool,
        delivery: DeliveryGuarantee,
        reply: oneshot::Sender<Result<(), PublisherError>>,
    },
    Subscribe {
        topic: String,
        delivery: DeliveryGuarantee,
        /// Best-effort: broker rejection does not rebuild the worker or
        /// escalate `PublisherError::Unavailable` to the caller.
        optional: bool,
        reply: oneshot::Sender<Result<(), PublisherError>>,
    },
    Unsubscribe {
        topic: String,
        reply: oneshot::Sender<Result<(), PublisherError>>,
    },
}

/// A message has already been durably written when it reaches the business
/// loop. The MQTT ACK is intentionally sent at that point, not after a slow
/// handler finishes; the local inbox ACK below is the replay boundary.
#[derive(Debug)]
pub struct MqttInbound {
    pub id: u64,
    pub frame: IncomingFrame,
}

#[derive(Debug, Clone)]
pub enum MqttInboundDisposition {
    Ack,
    Retry,
    DeadLetter { reason: String },
}

/// A generation-independent publisher handle. It is intentionally the only
/// MQTT object retained by the rest of the daemon.
#[derive(Clone)]
pub struct MqttPublisher {
    tx: mpsc::Sender<MqttCommand>,
}

impl MqttPublisher {
    pub fn channel() -> (Arc<Self>, mpsc::Receiver<MqttCommand>) {
        let (tx, rx) = mpsc::channel(COMMAND_CAPACITY);
        (Arc::new(Self { tx }), rx)
    }

    async fn send(
        &self,
        command: MqttCommand,
        reply: oneshot::Receiver<Result<(), PublisherError>>,
    ) -> Result<(), PublisherError> {
        self.tx.send(command).await.map_err(|_| {
            PublisherError::Unavailable("MQTT supervisor is shutting down".to_string())
        })?;
        reply.await.map_err(|_| {
            PublisherError::Unavailable("MQTT worker dropped the command".to_string())
        })?
    }
}

#[async_trait::async_trait]
impl MessagePublisher for MqttPublisher {
    async fn publish(
        &self,
        topic: &str,
        payload: Vec<u8>,
        retain: bool,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        let (reply, rx) = oneshot::channel();
        self.send(
            MqttCommand::Publish {
                topic: topic.to_string(),
                payload,
                retain,
                delivery,
                reply,
            },
            rx,
        )
        .await
    }

    async fn subscribe(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        self.subscribe_inner(topic, delivery, false).await
    }

    async fn subscribe_optional(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
    ) -> Result<(), PublisherError> {
        self.subscribe_inner(topic, delivery, true).await
    }

    async fn unsubscribe(&self, topic: &str) -> Result<(), PublisherError> {
        let (reply, rx) = oneshot::channel();
        self.send(
            MqttCommand::Unsubscribe {
                topic: topic.to_string(),
                reply,
            },
            rx,
        )
        .await
    }
}

impl MqttPublisher {
    async fn subscribe_inner(
        &self,
        topic: &str,
        delivery: DeliveryGuarantee,
        optional: bool,
    ) -> Result<(), PublisherError> {
        let (reply, rx) = oneshot::channel();
        self.send(
            MqttCommand::Subscribe {
                topic: topic.to_string(),
                delivery,
                optional,
                reply,
            },
            rx,
        )
        .await
    }
}

#[derive(Debug)]
pub enum MqttSupervisorEvent {
    /// The broker accepted the MQTT connection. Subscriptions and retained
    /// daemon state are not ready yet.
    TransportConnected {
        generation: u64,
        worker_generation: u64,
    },
    /// The worker restored every subscription known before this generation
    /// was rebuilt and received all corresponding SUBACK packets.
    SubscriptionsReady {
        generation: u64,
        worker_generation: u64,
    },
    /// The daemon command executor has completed subscriptions and state
    /// restoration for this generation.
    GenerationReady {
        generation: u64,
        worker_generation: u64,
    },
    Disconnected {
        generation: u64,
        worker_generation: u64,
        reason: String,
    },
    Rebuilt {
        generation: u64,
        worker_generation: u64,
        reason: String,
    },
    Terminated,
}

pub struct MqttSupervisor {
    pub events: mpsc::UnboundedReceiver<MqttSupervisorEvent>,
    pub inbound: mpsc::Receiver<MqttInbound>,
    inbound_disposition_tx: mpsc::Sender<(u64, MqttInboundDisposition)>,
    control_tx: mpsc::Sender<MqttControl>,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
    watchdog_shutdown: Option<oneshot::Sender<()>>,
    watchdog_join: Option<tokio::task::JoinHandle<()>>,
    snapshot: MqttSnapshotHandle,
}

enum MqttControl {
    GenerationReady {
        generation: u64,
        worker_generation: u64,
        reply: oneshot::Sender<bool>,
    },
    Rebuild {
        reason: String,
        /// Optional generation fence for rebuild requests originating from
        /// daemon-owned restore work. An old restore future must not tear down
        /// a newer worker that has already taken its place.
        fence: Option<(u64, u64)>,
    },
}

enum WorkerControl {
    GenerationReady {
        generation: u64,
        worker_generation: u64,
        reply: oneshot::Sender<bool>,
    },
}

enum WorkerEvent {
    Supervisor(MqttSupervisorEvent),
    Exited {
        worker_generation: u64,
        reason: String,
    },
}

#[derive(Default)]
struct MqttHeartbeat {
    last_progress_ms: std::sync::atomic::AtomicU64,
    poll_pending_since_ms: std::sync::atomic::AtomicU64,
}

impl MqttHeartbeat {
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn touch(&self) {
        self.last_progress_ms
            .store(Self::now_ms(), Ordering::Relaxed);
    }

    fn begin_poll(&self) {
        let now = Self::now_ms();
        let _ = self.poll_pending_since_ms.compare_exchange(
            0,
            now,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    fn end_poll(&self) {
        self.poll_pending_since_ms.store(0, Ordering::Relaxed);
    }
}

fn generation_is_current(active: u64, incoming: u64) -> bool {
    active == incoming
}

fn is_current_ready_generation(
    worker_present: bool,
    active_worker_generation: u64,
    active_generation: u64,
    transport_connected_generation: Option<u64>,
    ready_generation: u64,
    ready_worker_generation: u64,
) -> bool {
    worker_present
        && active_worker_generation == ready_worker_generation
        && transport_connected_generation == Some(ready_generation)
        && generation_is_current(active_generation, ready_generation)
}

fn rebuild_fence_matches_generation(
    worker_present: bool,
    active_generation: u64,
    active_worker_generation: u64,
    fence: Option<(u64, u64)>,
) -> bool {
    fence.map_or(true, |(expected_generation, expected_worker_generation)| {
        worker_present
            && active_generation == expected_generation
            && active_worker_generation == expected_worker_generation
    })
}

fn restart_delay(failure_count: u32) -> Duration {
    let shift = failure_count.saturating_sub(1).min(3);
    let multiplier = 1_u32 << shift;
    REBUILD_RETRY
        .checked_mul(multiplier)
        .unwrap_or(REBUILD_RETRY_MAX)
        .min(REBUILD_RETRY_MAX)
}

/// Whether a CONNACK refusal is one a fresh credential could fix.
///
/// Both codes show up against a JWT-authenticating broker and both mean the
/// password is the problem: EMQX answers `BadUserNamePassword` when the
/// signature verified but `exp` has passed, and `NotAuthorized` when no
/// authenticator matched the signature at all. Everything else (protocol
/// version, identifier rejected, server unavailable) is not about the
/// credential, so rebuilding the worker around a new token would not help.
fn connect_refusal_is_credential_failure(code: &rumqttc::mqttbytes::v4::ConnectReturnCode) -> bool {
    use rumqttc::mqttbytes::v4::ConnectReturnCode;
    matches!(
        code,
        ConnectReturnCode::BadUserNamePassword | ConnectReturnCode::NotAuthorized
    )
}

fn inbound_retry_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    Duration::from_secs(1_u64 << exponent).min(INBOUND_RETRY_MAX)
}

fn schedule_restart_at(next_restart: &mut Instant, restart_failures: &mut u32, now: Instant) {
    *restart_failures = restart_failures.saturating_add(1);
    let retry_at = now + restart_delay(*restart_failures);
    if *next_restart < retry_at {
        *next_restart = retry_at;
    }
}

fn schedule_restart(next_restart: &mut Instant, restart_failures: &mut u32) {
    schedule_restart_at(next_restart, restart_failures, Instant::now());
}

fn watchdog_rebuild_request_allowed(
    rebuild_due: bool,
    rebuild_requested_at: &mut Option<Instant>,
) -> bool {
    if !rebuild_due {
        *rebuild_requested_at = None;
        return false;
    }
    rebuild_requested_at.is_none()
}

fn wake_gap_requires_recovery(last_observed_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last_observed_ms) >= WAKE_GAP_THRESHOLD.as_millis() as u64
}

fn worker_event_matches_generation(
    active_worker_generation: u64,
    event: &MqttSupervisorEvent,
) -> bool {
    match event {
        MqttSupervisorEvent::TransportConnected {
            worker_generation, ..
        }
        | MqttSupervisorEvent::SubscriptionsReady {
            worker_generation, ..
        }
        | MqttSupervisorEvent::GenerationReady {
            worker_generation, ..
        }
        | MqttSupervisorEvent::Disconnected {
            worker_generation, ..
        }
        | MqttSupervisorEvent::Rebuilt {
            worker_generation, ..
        } => *worker_generation == active_worker_generation,
        MqttSupervisorEvent::Terminated => true,
    }
}

fn worker_exit_matches_generation(
    active_worker_generation: u64,
    exited_worker_generation: u64,
) -> bool {
    active_worker_generation == exited_worker_generation
}

fn emit_supervisor_event(
    events_tx: &mpsc::UnboundedSender<MqttSupervisorEvent>,
    event: MqttSupervisorEvent,
) {
    if events_tx.send(event).is_err() {
        debug!("MQTT supervisor event receiver is closed");
    }
}

impl MqttSupervisor {
    pub fn spawn(
        config: DaemonConfig,
        actor_id: String,
        initial_token: String,
        backend: Arc<dyn Backend>,
        command_rx: mpsc::Receiver<MqttCommand>,
        recovery_rx: mpsc::Receiver<MqttRecoveryRequest>,
        connected: Arc<AtomicBool>,
        snapshot: MqttSnapshotHandle,
    ) -> Self {
        // Lifecycle events are low-volume and must never be dropped: losing
        // SubscriptionsReady would leave the daemon permanently below the
        // generation readiness fence. This channel is separate from the
        // bounded command/inbound data paths.
        let (events_tx, events) = mpsc::unbounded_channel();
        let (inbound_tx, inbound) = mpsc::channel(INBOUND_CAPACITY);
        let (inbound_disposition_tx, inbound_disposition_rx) = mpsc::channel(INBOUND_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_CAPACITY);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let heartbeat = Arc::new(MqttHeartbeat::default());
        heartbeat.touch();
        let (watchdog_shutdown_tx, watchdog_shutdown_rx) = oneshot::channel();
        let watchdog_heartbeat = heartbeat.clone();
        let watchdog_control = control_tx.clone();
        let watchdog_join = tokio::spawn(async move {
            mqtt_watchdog(watchdog_heartbeat, watchdog_control, watchdog_shutdown_rx).await;
        });
        let supervisor_snapshot = snapshot.clone();
        let join = tokio::spawn(async move {
            run_supervisor(
                config,
                actor_id,
                initial_token,
                backend,
                command_rx,
                shutdown_rx,
                events_tx,
                inbound_tx,
                inbound_disposition_rx,
                control_rx,
                recovery_rx,
                connected,
                heartbeat,
                supervisor_snapshot,
            )
            .await;
        });

        Self {
            events,
            inbound,
            inbound_disposition_tx,
            control_tx,
            shutdown: Some(shutdown_tx),
            join: Some(join),
            watchdog_shutdown: Some(watchdog_shutdown_tx),
            watchdog_join: Some(watchdog_join),
            snapshot,
        }
    }

    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(tx) = self.watchdog_shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
        if let Some(join) = self.watchdog_join.take() {
            let _ = join.await;
        }
    }

    pub async fn mark_generation_ready(&self, generation: u64, worker_generation: u64) -> bool {
        let (reply, result) = oneshot::channel();
        if self
            .control_tx
            .send(MqttControl::GenerationReady {
                generation,
                worker_generation,
                reply,
            })
            .await
            .is_err()
        {
            return false;
        }
        result.await.unwrap_or(false)
    }

    pub async fn request_rebuild(&self, reason: impl Into<String>) {
        self.request_rebuild_with_fence(None, reason).await;
    }

    pub async fn request_rebuild_for_generation(
        &self,
        generation: u64,
        worker_generation: u64,
        reason: impl Into<String>,
    ) {
        self.request_rebuild_with_fence(Some((generation, worker_generation)), reason)
            .await;
    }

    async fn request_rebuild_with_fence(
        &self,
        fence: Option<(u64, u64)>,
        reason: impl Into<String>,
    ) {
        if self
            .control_tx
            .send(MqttControl::Rebuild {
                reason: reason.into(),
                fence,
            })
            .await
            .is_err()
        {
            warn!("MQTT supervisor closed before rebuild request could be delivered");
        }
    }

    /// Mark a durable inbound message handled, or ask the worker to replay it
    /// after a transient business failure/timeout.
    pub async fn dispose_inbound(&self, id: u64, disposition: MqttInboundDisposition) {
        if let Err(error) = self.inbound_disposition_tx.send((id, disposition)).await {
            warn!(id, %error, "MQTT supervisor closed before durable inbound disposition");
        }
    }

    /// Check the generation fence without waiting on the supervisor loop. This
    /// is used by the daemon-owned state restore future, which may be awaiting
    /// cloud/storage work while a recovery signal rebuilds the worker.
    pub fn is_generation_current(&self, generation: u64, worker_generation: u64) -> bool {
        let snapshot = self.snapshot.read();
        snapshot.worker_generation == Some(worker_generation)
            && snapshot.connection_attempt == Some(generation)
            && matches!(snapshot.phase.as_str(), "TransportConnected" | "Restoring")
    }
}

struct WorkerHandle {
    command_tx: mpsc::Sender<MqttCommand>,
    disposition_tx: mpsc::Sender<(u64, MqttInboundDisposition)>,
    control_tx: mpsc::Sender<WorkerControl>,
    stop_tx: Option<oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

async fn run_supervisor(
    config: DaemonConfig,
    actor_id: String,
    initial_token: String,
    backend: Arc<dyn Backend>,
    mut command_rx: mpsc::Receiver<MqttCommand>,
    mut shutdown_rx: oneshot::Receiver<()>,
    events_tx: mpsc::UnboundedSender<MqttSupervisorEvent>,
    inbound_tx: mpsc::Sender<MqttInbound>,
    mut inbound_disposition_rx: mpsc::Receiver<(u64, MqttInboundDisposition)>,
    mut control_rx: mpsc::Receiver<MqttControl>,
    mut recovery_rx: mpsc::Receiver<MqttRecoveryRequest>,
    connected: Arc<AtomicBool>,
    heartbeat: Arc<MqttHeartbeat>,
    snapshot: MqttSnapshotHandle,
) {
    let (worker_events_tx, mut worker_events_rx) = mpsc::channel(128);
    let mut worker = Some(spawn_worker(
        config.clone(),
        actor_id.clone(),
        initial_token,
        backend.clone(),
        0,
        0,
        BTreeMap::new(),
        worker_events_tx.clone(),
        inbound_tx.clone(),
        connected.clone(),
        heartbeat.clone(),
    ));
    let mut subscriptions = BTreeMap::<String, TrackedSubscription>::new();
    let mut pending_commands = VecDeque::<MqttCommand>::new();
    let mut pending_dispositions = VecDeque::<(u64, MqttInboundDisposition)>::new();
    let mut generation = 0_u64;
    let mut worker_generation = 0_u64;
    let mut transport_connected_generation = None::<u64>;
    let mut restart_reason = None::<String>;
    let mut next_restart = Instant::now();
    let mut restart_failures = 0_u32;
    let mut shutting_down = false;
    let mut ready_connection_generation = None::<u64>;
    let mut last_observed_ms = MqttHeartbeat::now_ms();
    let mut credential_attempt = 0_u64;
    let mut recovery_signal_count = 0_u64;
    let mut storage_blocked = false;
    // A recovery signal is an edge, not a command to repeatedly tear down the
    // worker. Keep the state in the supervisor so focus/online/watchdog/wake
    // signals all converge on one active recovery attempt.
    let mut recovery_in_progress = false;
    let mut recovery_coalescing = None::<Arc<AtomicBool>>;

    snapshot_update(&snapshot, |current| {
        current.phase = "Connecting".to_string();
        current.worker_generation = Some(worker_generation);
        current.ready_generation = None;
    });

    loop {
        if let Some(active) = worker.as_ref() {
            while let Some(command) = pending_commands.pop_front() {
                match active.command_tx.try_send(command) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(command)) => {
                        pending_commands.push_front(command);
                        break;
                    }
                    Err(mpsc::error::TrySendError::Closed(command)) => {
                        pending_commands.push_front(command);
                        restart_reason.get_or_insert_with(|| {
                            "MQTT worker command channel closed".to_string()
                        });
                        break;
                    }
                }
            }
            while let Some(disposition) = pending_dispositions.pop_front() {
                match active.disposition_tx.try_send(disposition) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(disposition)) => {
                        pending_dispositions.push_front(disposition);
                        break;
                    }
                    Err(mpsc::error::TrySendError::Closed(disposition)) => {
                        pending_dispositions.push_front(disposition);
                        restart_reason.get_or_insert_with(|| {
                            "MQTT worker disposition channel closed".to_string()
                        });
                        break;
                    }
                }
            }
        }

        if worker.is_none() && !storage_blocked && !shutting_down && Instant::now() >= next_restart
        {
            let reason = restart_reason
                .take()
                .unwrap_or_else(|| "MQTT worker exited".to_string());
            credential_attempt = credential_attempt.saturating_add(1);
            let credential_started = Instant::now();
            info!(
                worker_generation = worker_generation.saturating_add(1),
                credential_attempt,
                %reason,
                "starting MQTT credential attempt"
            );
            snapshot_update(&snapshot, |current| {
                current.phase = "AuthRecovering".to_string();
                current.connected = false;
                current.ready_generation = None;
            });
            let token =
                match tokio::time::timeout(Duration::from_secs(10), backend.auth_token()).await {
                    Ok(Ok(token)) => token,
                    Ok(Err(error)) => {
                        warn!(
                            %error,
                            credential_attempt,
                            duration_ms = credential_started.elapsed().as_millis() as u64,
                            "could not obtain MQTT credential while starting a new worker"
                        );
                        schedule_restart(&mut next_restart, &mut restart_failures);
                        snapshot_update(&snapshot, |current| {
                            current.phase = "Backoff".to_string();
                            current.last_error_code = Some("cloud_auth_failure".to_string());
                            current.next_retry_at = Some(
                                chrono::Utc::now()
                                    + chrono::Duration::seconds(
                                        restart_delay(restart_failures).as_secs() as i64,
                                    ),
                            );
                        });
                        continue;
                    }
                    Err(_) => {
                        warn!(
                            credential_attempt,
                            duration_ms = credential_started.elapsed().as_millis() as u64,
                            "timed out obtaining MQTT credential while starting a new worker"
                        );
                        schedule_restart(&mut next_restart, &mut restart_failures);
                        snapshot_update(&snapshot, |current| {
                            current.phase = "Backoff".to_string();
                            current.last_error_code = Some("cloud_auth_timeout".to_string());
                            current.next_retry_at = Some(
                                chrono::Utc::now()
                                    + chrono::Duration::seconds(
                                        restart_delay(restart_failures).as_secs() as i64,
                                    ),
                            );
                        });
                        continue;
                    }
                };
            info!(
                credential_attempt,
                duration_ms = credential_started.elapsed().as_millis() as u64,
                "MQTT credential attempt succeeded"
            );
            connected.store(false, Ordering::Relaxed);
            worker_generation = worker_generation.wrapping_add(1);
            let rebuilt_generation = generation;
            worker = Some(spawn_worker(
                config.clone(),
                actor_id.clone(),
                token,
                backend.clone(),
                generation,
                worker_generation,
                subscriptions.clone(),
                worker_events_tx.clone(),
                inbound_tx.clone(),
                connected.clone(),
                heartbeat.clone(),
            ));
            snapshot_update(&snapshot, |current| {
                current.phase = "Connecting".to_string();
                current.worker_generation = Some(worker_generation);
                current.connected = false;
                current.ready_generation = None;
                current.next_retry_at = None;
            });
            emit_supervisor_event(
                &events_tx,
                MqttSupervisorEvent::Rebuilt {
                    generation: rebuilt_generation,
                    worker_generation,
                    reason,
                },
            );
        }

        let tick = tokio::time::sleep(SUPERVISOR_TICK);
        tokio::pin!(tick);
        tokio::select! {
            _ = &mut shutdown_rx => {
                shutting_down = true;
                break;
            }
            command = command_rx.recv() => {
                let Some(command) = command else {
                    shutting_down = true;
                    break;
                };
                if pending_commands.len() >= WORKER_COMMAND_CAPACITY {
                    fail_command(command, "MQTT worker command queue is full");
                } else {
                    match &command {
                        MqttCommand::Subscribe {
                            topic,
                            delivery,
                            optional,
                            ..
                        } => {
                            subscriptions.insert(
                                topic.clone(),
                                TrackedSubscription {
                                    qos: delivery.clone().into(),
                                    optional: *optional,
                                },
                            );
                        }
                        MqttCommand::Unsubscribe { topic, .. } => {
                            subscriptions.remove(topic);
                        }
                        MqttCommand::Publish { .. } => {}
                    }
                    pending_commands.push_back(command);
                }
            }
            disposition = inbound_disposition_rx.recv() => {
                if let Some(disposition) = disposition {
                    if pending_dispositions.len() >= WORKER_DISPOSITION_CAPACITY {
                        warn!("MQTT inbound disposition queue is full; durable item will replay after restart");
                    } else {
                        pending_dispositions.push_back(disposition);
                    }
                }
            }
            control = control_rx.recv() => {
                match control {
                    Some(MqttControl::GenerationReady { generation: ready_generation, worker_generation: ready_worker, reply }) => {
                        let accepted = is_current_ready_generation(
                            worker.is_some(),
                            worker_generation,
                            generation,
                            transport_connected_generation,
                            ready_generation,
                            ready_worker,
                        );
                        if accepted {
                            if let Some(active) = worker.as_ref() {
                                let readiness = WorkerControl::GenerationReady {
                                    generation: ready_generation,
                                    worker_generation: ready_worker,
                                    reply,
                                };
                                match active.control_tx.try_send(readiness) {
                                    Ok(()) => {}
                                    Err(mpsc::error::TrySendError::Full(WorkerControl::GenerationReady { reply, .. }))
                                    | Err(mpsc::error::TrySendError::Closed(WorkerControl::GenerationReady { reply, .. })) => {
                                        let _ = reply.send(false);
                                        warn!(generation = ready_generation, "failed to forward MQTT generation readiness");
                                    }
                                }
                            }
                        } else {
                            let _ = reply.send(false);
                            warn!(generation = ready_generation, active_generation = generation, "ignored stale MQTT generation readiness");
                        }
                    }
                    Some(MqttControl::Rebuild { reason, fence }) => {
                        if !rebuild_fence_matches_generation(
                            worker.is_some(),
                            generation,
                            worker_generation,
                            fence,
                        ) {
                            let (expected_generation, expected_worker_generation) =
                                fence.expect("fence must be present when the match failed");
                            warn!(
                                generation,
                                worker_generation,
                                expected_generation,
                                expected_worker_generation,
                                %reason,
                                "ignoring stale fenced MQTT rebuild request"
                            );
                            continue;
                        }
                        if is_durable_store_failure(&reason) {
                            storage_blocked = true;
                            restart_reason = None;
                            recovery_in_progress = false;
                            if let Some(coalescing) = recovery_coalescing.take() {
                                coalescing.store(false, Ordering::Release);
                            }
                            transport_connected_generation = None;
                            connected.store(false, Ordering::Relaxed);
                            ready_connection_generation = None;
                            stop_worker(&mut worker, &heartbeat).await;
                            snapshot_update(&snapshot, |current| {
                                current.phase = "StorageError".to_string();
                                current.connected = false;
                                current.ready_generation = None;
                                current.last_error_code = Some("durable_store_corrupt".to_string());
                                current.last_error_at = Some(chrono::Utc::now());
                                current.next_retry_at = None;
                            });
                            error!(%reason, "MQTT durable store failure fenced the active generation; automatic rebuilds are paused");
                            continue;
                        }
                        let first_request = restart_reason.is_none();
                        restart_reason.get_or_insert(reason);
                        if worker.is_some() {
                            stop_worker(&mut worker, &heartbeat).await;
                            transport_connected_generation = None;
                            connected.store(false, Ordering::Relaxed);
                            ready_connection_generation = None;
                            if first_request {
                                schedule_restart(&mut next_restart, &mut restart_failures);
                            }
                        } else if first_request {
                            // A rebuild signal arriving while credential/backoff
                            // recovery is already in progress only wakes the
                            // existing retry. It must not count as another
                            // worker failure or reset the exponential backoff
                            // repeatedly.
                            next_restart = Instant::now();
                        }
                    }
                    None => {
                        shutting_down = true;
                        break;
                    }
                }
            }
            request = recovery_rx.recv() => {
                if let Some(request) = request {
                    recovery_signal_count = recovery_signal_count.saturating_add(1);
                    let current_generation = (worker.is_some()).then_some(worker_generation);
                    let healthy = worker.is_some()
                        && ready_connection_generation == Some(generation)
                        && connected.load(Ordering::Relaxed);
                    if healthy {
                        info!(
                            recovery_signal_count,
                            worker_generation = ?current_generation,
                            reason = %request.reason.as_str(),
                            "ignored MQTT recovery signal because generation is healthy"
                        );
                        let _ = request.reply.send(MqttRecoveryAccepted {
                            accepted: true,
                            outcome: MqttRecoveryOutcome::AlreadyHealthy,
                            request_id: request.request_id,
                            worker_generation: current_generation,
                        });
                    } else {
                        if storage_blocked && !recovery_may_retry_storage(request.reason) {
                            let _ = request.reply.send(MqttRecoveryAccepted {
                                accepted: false,
                                outcome: MqttRecoveryOutcome::Recovering,
                                request_id: request.request_id,
                                worker_generation: current_generation,
                            });
                            continue;
                        }
                        let reason = format!("{} recovery", request.reason.as_str());
                        let already_recovering = recovery_in_progress;
                        info!(
                            recovery_signal_count,
                            worker_generation = ?current_generation,
                            reason = %request.reason.as_str(),
                            coalesced = already_recovering,
                            "accepted MQTT recovery signal"
                        );
                        snapshot_update(&snapshot, |current| {
                            if !already_recovering {
                                current.phase = "Recovering".to_string();
                            }
                            current.last_recovery_reason = Some(request.reason.as_str().to_string());
                            current.connected = false;
                            current.ready_generation = None;
                            current.next_retry_at = None;
                        });
                        recovery_in_progress = true;
                        // Only an explicit user request may retry a durable
                        // store that was classified as broken. Automatic
                        // wake/network signals must not turn a disk failure
                        // into a rebuild loop.
                        if recovery_may_retry_storage(request.reason) {
                            storage_blocked = false;
                        }
                        recovery_coalescing = Some(request.coalescing.clone());
                        ready_connection_generation = None;
                        let _ = request.reply.send(MqttRecoveryAccepted {
                            accepted: true,
                            outcome: MqttRecoveryOutcome::Recovering,
                            request_id: request.request_id,
                            worker_generation: current_generation,
                        });
                        // Once a recovery is active, later signals only update
                        // the reason above. Repeated teardown here was the
                        // source of rebuild storms after a laptop wake or a
                        // flapping VPN.
                        if !already_recovering && worker.is_some() {
                            stop_worker(&mut worker, &heartbeat).await;
                            transport_connected_generation = None;
                            connected.store(false, Ordering::Relaxed);
                        }
                        restart_reason.get_or_insert(reason);
                        if !already_recovering {
                            next_restart = Instant::now();
                        }
                    }
                } else {
                    shutting_down = true;
                    break;
                }
            }
            event = worker_events_rx.recv() => {
                match event {
                    Some(WorkerEvent::Supervisor(event)) => {
                        if !worker_event_matches_generation(worker_generation, &event) {
                            warn!(
                                active_worker_generation = worker_generation,
                                "discarding stale MQTT worker event"
                            );
                            continue;
                        }
                        match &event {
                            MqttSupervisorEvent::TransportConnected { generation: current, .. } => {
                                generation = *current;
                                transport_connected_generation = Some(*current);
                                snapshot_update(&snapshot, |current_snapshot| {
                                    current_snapshot.phase = "TransportConnected".to_string();
                                    current_snapshot.worker_generation = Some(worker_generation);
                                    current_snapshot.connection_attempt = Some(current_snapshot.connection_attempt.unwrap_or(0).saturating_add(1));
                                    current_snapshot.connected = false;
                                    current_snapshot.ready_generation = None;
                                });
                            }
                            MqttSupervisorEvent::Disconnected { reason, .. } => {
                                transport_connected_generation = None;
                                connected.store(false, Ordering::Relaxed);
                                ready_connection_generation = None;
                                snapshot_update(&snapshot, |current| {
                                    current.phase = "Recovering".to_string();
                                    current.connected = false;
                                    current.ready_generation = None;
                                    current.last_error_code = Some(mqtt_error_code(reason).to_string());
                                    current.last_error_at = Some(chrono::Utc::now());
                                });
                            }
                            MqttSupervisorEvent::GenerationReady { generation: ready_gen, worker_generation: ready_worker } => {
                                if is_current_ready_generation(
                                    worker.is_some(),
                                    worker_generation,
                                    generation,
                                    transport_connected_generation,
                                    *ready_gen,
                                    *ready_worker,
                                ) {
                                    restart_failures = 0;
                                    recovery_in_progress = false;
                                    if let Some(coalescing) = recovery_coalescing.take() {
                                        coalescing.store(false, Ordering::Release);
                                    }
                                    ready_connection_generation = Some(*ready_gen);
                                    snapshot_update(&snapshot, |current| {
                                        current.phase = "Ready".to_string();
                                        current.connected = true;
                                        current.ready_generation = Some(*ready_worker);
                                        current.last_ready_at = Some(chrono::Utc::now());
                                        current.next_retry_at = None;
                                    });
                                } else {
                                    debug!(
                                        generation = *ready_gen,
                                        active_generation = generation,
                                        "ignored stale MQTT generation readiness for restart backoff"
                                    );
                                }
                            }
                            MqttSupervisorEvent::SubscriptionsReady { .. } => {
                                snapshot_update(&snapshot, |current| {
                                    current.phase = "Restoring".to_string();
                                });
                            }
                            MqttSupervisorEvent::Rebuilt { .. }
                            | MqttSupervisorEvent::Terminated => {}
                        }
                        emit_supervisor_event(&events_tx, event);
                    }
                    Some(WorkerEvent::Exited {
                        worker_generation: exited_worker_generation,
                        reason,
                    }) => {
                        if !worker_exit_matches_generation(worker_generation, exited_worker_generation) {
                            warn!(
                                active_worker_generation = worker_generation,
                                exited_worker_generation,
                                "discarding stale MQTT worker exit event"
                            );
                            continue;
                        }
                        if is_durable_store_failure(&reason) {
                            storage_blocked = true;
                            restart_reason = None;
                            recovery_in_progress = false;
                            if let Some(coalescing) = recovery_coalescing.take() {
                                coalescing.store(false, Ordering::Release);
                            }
                            transport_connected_generation = None;
                            connected.store(false, Ordering::Relaxed);
                            ready_connection_generation = None;
                            stop_worker(&mut worker, &heartbeat).await;
                            snapshot_update(&snapshot, |current| {
                                current.phase = "StorageError".to_string();
                                current.connected = false;
                                current.ready_generation = None;
                                current.last_error_code = Some("durable_store_corrupt".to_string());
                                current.last_error_at = Some(chrono::Utc::now());
                                current.next_retry_at = None;
                            });
                            error!(%reason, "MQTT durable store is unavailable; automatic rebuilds are paused");
                            continue;
                        }
                        if storage_blocked {
                            debug!(%reason, "ignoring MQTT worker exit while durable store recovery is blocked");
                            continue;
                        }
                        if !shutting_down {
                            warn!(%reason, "MQTT worker exited; supervisor will create a new generation");
                            restart_reason = Some(reason.clone());
                            transport_connected_generation = None;
                            connected.store(false, Ordering::Relaxed);
                            ready_connection_generation = None;
                            let had_worker = worker.is_some();
                            stop_worker(&mut worker, &heartbeat).await;
                            if had_worker {
                                schedule_restart(&mut next_restart, &mut restart_failures);
                            }
                            snapshot_update(&snapshot, |current| {
                                current.phase = "Backoff".to_string();
                                current.connected = false;
                                current.ready_generation = None;
                                current.last_error_code = Some(mqtt_error_code(&reason).to_string());
                                current.last_error_at = Some(chrono::Utc::now());
                                current.next_retry_at = Some(chrono::Utc::now() + chrono::Duration::seconds(restart_delay(restart_failures).as_secs() as i64));
                            });
                        }
                    }
                    None => {
                        restart_reason = Some("MQTT worker event channel closed".to_string());
                        stop_worker(&mut worker, &heartbeat).await;
                        schedule_restart(&mut next_restart, &mut restart_failures);
                    }
                }
            }
            _ = &mut tick => {}
        }

        let now_ms = MqttHeartbeat::now_ms();
        if wake_gap_requires_recovery(last_observed_ms, now_ms) {
            last_observed_ms = now_ms;
            if !shutting_down && !recovery_in_progress {
                recovery_in_progress = true;
                snapshot_update(&snapshot, |current| {
                    current.phase = "Recovering".to_string();
                    current.connected = false;
                    current.ready_generation = None;
                    current.last_recovery_reason = Some("daemon_wake_gap".to_string());
                    current.next_retry_at = None;
                });
                ready_connection_generation = None;
                restart_reason.get_or_insert("daemon wake gap recovery".to_string());
                // A wall-clock gap means the old socket may have survived in
                // a half-closed state. Stop that generation even if its last
                // snapshot said Ready, then let the normal credential/backoff
                // path create exactly one replacement worker.
                if worker.is_some() {
                    stop_worker(&mut worker, &heartbeat).await;
                    transport_connected_generation = None;
                    connected.store(false, Ordering::Relaxed);
                }
                next_restart = Instant::now();
            }
        } else {
            last_observed_ms = now_ms;
        }
    }

    connected.store(false, Ordering::Relaxed);
    snapshot_update(&snapshot, |current| {
        current.phase = "Stopped".to_string();
        current.connected = false;
        current.ready_generation = None;
    });
    stop_worker(&mut worker, &heartbeat).await;
    while let Some(command) = pending_commands.pop_front() {
        fail_command(command, "MQTT supervisor is shutting down");
    }
    emit_supervisor_event(&events_tx, MqttSupervisorEvent::Terminated);
}

fn spawn_worker(
    config: DaemonConfig,
    actor_id: String,
    initial_token: String,
    backend: Arc<dyn Backend>,
    generation_seed: u64,
    worker_generation: u64,
    initial_subscriptions: BTreeMap<String, TrackedSubscription>,
    events_tx: mpsc::Sender<WorkerEvent>,
    inbound_tx: mpsc::Sender<MqttInbound>,
    connected: Arc<AtomicBool>,
    heartbeat: Arc<MqttHeartbeat>,
) -> WorkerHandle {
    let (command_tx, command_rx) = mpsc::channel(WORKER_COMMAND_CAPACITY);
    let (disposition_tx, disposition_rx) = mpsc::channel(WORKER_DISPOSITION_CAPACITY);
    let (control_tx, control_rx) = mpsc::channel(CONTROL_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let worker = MqttWorker {
            config,
            actor_id,
            initial_token,
            backend,
            command_rx,
            stop_rx,
            events_tx,
            inbound_tx,
            inbound_disposition_rx: disposition_rx,
            control_rx,
            connected,
            heartbeat,
            generation_seed,
            worker_generation,
            initial_subscriptions,
        };
        worker.run().await;
    });
    WorkerHandle {
        command_tx,
        disposition_tx,
        control_tx,
        stop_tx: Some(stop_tx),
        join,
    }
}

async fn stop_worker(worker: &mut Option<WorkerHandle>, heartbeat: &MqttHeartbeat) {
    heartbeat.end_poll();
    let Some(mut active) = worker.take() else {
        return;
    };
    if let Some(stop_tx) = active.stop_tx.take() {
        let _ = stop_tx.send(());
    }
    if tokio::time::timeout(WORKER_STOP_TIMEOUT, &mut active.join)
        .await
        .is_err()
    {
        warn!("MQTT worker did not stop within the grace period; aborting its task");
        active.join.abort();
        let _ = active.join.await;
    }
}

fn fail_command(command: MqttCommand, reason: &str) {
    let error = PublisherError::Unavailable(reason.to_string());
    match command {
        MqttCommand::Publish { reply, .. }
        | MqttCommand::Subscribe { reply, .. }
        | MqttCommand::Unsubscribe { reply, .. } => {
            let _ = reply.send(Err(error));
        }
    }
}

struct MqttWorker {
    config: DaemonConfig,
    actor_id: String,
    initial_token: String,
    backend: Arc<dyn Backend>,
    command_rx: mpsc::Receiver<MqttCommand>,
    stop_rx: oneshot::Receiver<()>,
    events_tx: mpsc::Sender<WorkerEvent>,
    inbound_tx: mpsc::Sender<MqttInbound>,
    inbound_disposition_rx: mpsc::Receiver<(u64, MqttInboundDisposition)>,
    control_rx: mpsc::Receiver<WorkerControl>,
    connected: Arc<AtomicBool>,
    heartbeat: Arc<MqttHeartbeat>,
    generation_seed: u64,
    worker_generation: u64,
    initial_subscriptions: BTreeMap<String, TrackedSubscription>,
}

impl MqttWorker {
    async fn run(mut self) {
        let mut store = match DurableMqttStore::open_default() {
            Ok(store) => store,
            Err(error) => {
                error!(%error, "failed to open durable MQTT inbox/outbox");
                self.connected.store(false, Ordering::Relaxed);
                let _ = self
                    .events_tx
                    .send(WorkerEvent::Exited {
                        worker_generation: self.worker_generation,
                        reason: format!("{DURABLE_STORE_FAILURE_PREFIX}open_failed"),
                    })
                    .await;
                return;
            }
        };
        let mut client = match MqttClient::new(&self.config, &self.actor_id, &self.initial_token) {
            Ok(client) => Some(client),
            Err(error) => {
                error!(%error, "failed to build initial MQTT client");
                None
            }
        };
        let mut generation = self.generation_seed;
        let mut poll_error_count = 0_u64;
        let mut connected = false;
        let mut generation_ready = false;
        let mut recovery_started = None;
        let mut next_proactive_reconnect =
            proactive_reconnect_deadline(self.backend.cached_credential_expiry_epoch());
        let mut subscriptions = self.initial_subscriptions.clone();
        let mut pending = load_pending_publishes(&store);
        let mut publish_waiting_for_write = VecDeque::<u64>::new();
        let mut publish_inflight = HashMap::<u16, u64>::new();
        let mut subscribe_waiting_for_write = VecDeque::<PendingSubscribe>::new();
        let mut subscribe_inflight = HashMap::<u16, PendingSubscribe>::new();
        let mut inbound_staging = load_pending_inbound(&store);
        let mut inbound_retry_attempts = HashMap::<u64, u32>::new();
        let mut inbound_retry_deadlines = HashMap::<u64, Instant>::new();
        let mut forced_rebuild = None::<String>;
        let mut auto_restore_subscriptions = false;
        let mut subscriptions_ready_announced = false;
        let mut exit_reason = "MQTT worker stopped".to_string();
        // An ABSOLUTE deadline, deliberately hoisted out of the loop. It used
        // to be a fresh `sleep(SUPERVISOR_TICK)` per iteration, which starves
        // the tick arm whenever the event loop errors faster than the tick
        // period: a rejected CONNACK comes back in ~10ms, so the timer was
        // dropped and recreated ~100x/s and never once elapsed. That silently
        // disabled everything the tick arm owns — `RECOVERY_DEADLINE`,
        // `forced_rebuild`, and the proactive credential refresh. Observed in
        // production as a worker stuck at `generation=0` with
        // `poll_error_count=3065410` after 8.4 hours, hammering the broker at
        // ~100 connects/s and never picking up the refreshed token sitting on
        // disk. With an absolute deadline the arm fires on schedule no matter
        // how fast the loop spins.
        let mut next_tick = tokio::time::Instant::now() + SUPERVISOR_TICK;

        loop {
            self.heartbeat.touch();
            self.flush_due_inbound_retries(
                &mut store,
                &mut inbound_staging,
                &mut inbound_retry_deadlines,
            );
            self.flush_inbound(&mut inbound_staging);

            if connected && generation_ready {
                self.flush_pending(&mut client, &mut pending, &mut publish_waiting_for_write);
            }

            let tick = tokio::time::sleep_until(next_tick);
            tokio::pin!(tick);

            if let Some(active) = client.as_mut() {
                // Keep driving the event loop even when the durable inbox is
                // full. Backpressure must stop accepting/ACKing business
                // messages, not MQTT keepalive traffic.
                self.heartbeat.begin_poll();
                tokio::select! {
                    _ = &mut self.stop_rx => {
                        exit_reason = "MQTT worker stop requested".to_string();
                        break;
                    }
                    command = self.command_rx.recv() => {
                        if !self.accept_command(
                            command,
                            connected,
                            Some(active.client.clone()),
                            &mut subscriptions,
                            &mut pending,
                            &mut store,
                            &mut subscribe_waiting_for_write,
                        ) {
                            exit_reason = "MQTT worker command channel closed".to_string();
                            break;
                        }
                    }
                    control = self.control_rx.recv() => {
                        match control {
                            Some(WorkerControl::GenerationReady { generation: ready_generation, worker_generation: ready_worker_generation, reply }) => {
                                let accepted = generation_is_current(generation, ready_generation)
                                    && self.worker_generation == ready_worker_generation
                                    && connected;
                                if accepted {
                                    generation_ready = true;
                                    self.connected.store(true, Ordering::Relaxed);
                                    let _ = self.events_tx.send(WorkerEvent::Supervisor(MqttSupervisorEvent::GenerationReady {
                                        generation: ready_generation,
                                        worker_generation: ready_worker_generation,
                                    })).await;
                                    info!(generation = ready_generation, "MQTT generation is fully ready");
                                } else {
                                    warn!(generation = ready_generation, active_generation = generation, connected, "ignored stale MQTT generation readiness");
                                }
                                let _ = reply.send(accepted);
                            }
                            None => {
                                exit_reason = "MQTT worker control channel closed".to_string();
                                break;
                            }
                        }
                    }
                    disposition = self.inbound_disposition_rx.recv() => {
                        if let Some((id, disposition)) = disposition {
                            if let Err(reason) = self.handle_inbound_disposition(
                                id,
                                disposition,
                                &mut store,
                                &mut inbound_retry_attempts,
                                &mut inbound_retry_deadlines,
                            ) {
                                exit_reason = reason;
                                break;
                            }
                        }
                    }
                    poll_result = active.eventloop.poll() => {
                        match poll_result {
                            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                                let previous_poll_errors = poll_error_count;
                                poll_error_count = 0;
                                self.requeue_publish_attempts(
                                    &mut pending,
                                    &mut publish_waiting_for_write,
                                    &mut publish_inflight,
                                    &store,
                                );
                                self.fail_pending_subscriptions(
                                    &mut subscribe_waiting_for_write,
                                    &mut subscribe_inflight,
                                    "MQTT connection generation changed",
                                );
                                generation = generation.wrapping_add(1);
                                connected = true;
                                generation_ready = false;
                                recovery_started = None;
                                self.connected.store(false, Ordering::Relaxed);
                                self.heartbeat.end_poll();
                                auto_restore_subscriptions = !subscriptions.is_empty();
                                subscriptions_ready_announced = !auto_restore_subscriptions;
                                if auto_restore_subscriptions {
                                    for (topic, tracked) in &subscriptions {
                                        if let Err(error) =
                                            active.client.try_subscribe(topic.clone(), tracked.qos)
                                        {
                                            warn!(%error, topic, generation, "failed to queue MQTT subscription restore");
                                            match suback_failure_action(tracked.optional) {
                                                SubackFailureAction::Tolerate => {
                                                    warn_optional_subscribe_rejected(topic);
                                                }
                                                SubackFailureAction::ForceRebuild => {
                                                    forced_rebuild = Some(
                                                        "subscription restore queue rejected"
                                                            .to_string(),
                                                    );
                                                }
                                            }
                                        } else {
                                            subscribe_waiting_for_write.push_back(PendingSubscribe {
                                                topic: topic.clone(),
                                                optional: tracked.optional,
                                                reply: None,
                                            });
                                        }
                                    }
                                }
                                next_proactive_reconnect = proactive_reconnect_deadline(
                                    self.backend.cached_credential_expiry_epoch(),
                                );
                                info!(generation, subscriptions = subscriptions.len(), previous_poll_errors, "MQTT transport connected; waiting for subscription and state restore");
                                let _ = self.events_tx.send(WorkerEvent::Supervisor(MqttSupervisorEvent::TransportConnected {
                                    generation,
                                    worker_generation: self.worker_generation,
                                })).await;
                                if !auto_restore_subscriptions {
                                    self.announce_subscriptions_ready(
                                        generation,
                                        &mut subscriptions_ready_announced,
                                    ).await;
                                }
                            }
                            Ok(Event::Incoming(Packet::Publish(publish))) => {
                                self.heartbeat.end_poll();
                                if subscriber::parse_incoming(&publish).is_some() {
                                    let frame = IncomingFrame {
                                        topic: publish.topic.clone(),
                                        payload: publish.payload.to_vec(),
                                        retained: publish.retain,
                                    };
                                    if durable_inbox_blocked(&store)
                                        || store
                                            .inbox_bytes()
                                            .saturating_add(frame.topic.len())
                                            .saturating_add(frame.payload.len())
                                            > DURABLE_QUEUE_MAX_BYTES
                                    {
                                        warn!(
                                            capacity = DURABLE_QUEUE_CAPACITY,
                                            max_bytes = DURABLE_QUEUE_MAX_BYTES,
                                            "durable MQTT inbox is full; withholding broker ACK until business ACK"
                                        );
                                    } else {
                                        let message_id = subscriber::stable_message_id(&frame);
                                        match store.enqueue_inbound(frame.clone(), message_id) {
                                            Ok(Some(id)) => {
                                                inbound_staging.push_back(MqttInbound { id, frame });
                                                // manual_acks is enabled in MqttClient. The
                                                // broker ACK is emitted only after the local
                                                // durable inbox append has synced.
                                                if let Err(error) = active.client.try_ack(&publish) {
                                                    warn!(%error, "failed to ACK durably stored MQTT inbound");
                                                }
                                            }
                                            Ok(None) => {
                                                // The durable dedup key was already accepted. It
                                                // is safe to ACK this broker redelivery without
                                                // scheduling a second business execution.
                                                if let Err(error) = active.client.try_ack(&publish) {
                                                    warn!(%error, "failed to ACK deduplicated MQTT inbound");
                                                }
                                            }
                                            Err(error) => {
                                                error!(%error, "failed to append MQTT inbound to durable inbox");
                                                // The inbox Put may already be durable while the
                                                // dedup record failed. Reopen the store in a fresh
                                                // worker so startup can rebuild dedup from that
                                                // pending inbox item before accepting a redelivery.
                                                forced_rebuild = Some(format!(
                                                    "{DURABLE_STORE_FAILURE_PREFIX}inbound_persistence_failed: {error}"
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(Event::Incoming(Packet::PubAck(ack))) => {
                                self.heartbeat.end_poll();
                                if let Some(id) = publish_inflight.remove(&ack.pkid) {
                                    self.ack_publish(id, &mut store);
                                }
                            }
                            Ok(Event::Incoming(Packet::PubComp(comp))) => {
                                self.heartbeat.end_poll();
                                if let Some(id) = publish_inflight.remove(&comp.pkid) {
                                    self.ack_publish(id, &mut store);
                                }
                            }
                            Ok(Event::Incoming(Packet::SubAck(ack))) => {
                                self.heartbeat.end_poll();
                                if let Some(request) = subscribe_inflight.remove(&ack.pkid) {
                                    let success = !ack.return_codes.iter().any(|code| {
                                        matches!(code, rumqttc::SubscribeReasonCode::Failure)
                                    });
                                    let tolerate_failure = !success
                                        && matches!(
                                            suback_failure_action(request.optional),
                                            SubackFailureAction::Tolerate
                                        );
                                    if tolerate_failure {
                                        warn_optional_subscribe_rejected(&request.topic);
                                    }
                                    // Optional reject: Ok to caller so mqtt_resubscribe
                                    // does not escalate into a generation rebuild.
                                    let result = if success || request.optional {
                                        Ok(())
                                    } else {
                                        Err(PublisherError::Unavailable(format!(
                                            "MQTT broker rejected subscription for {}",
                                            request.topic
                                        )))
                                    };
                                    if let Some(reply) = request.reply {
                                        let _ = reply.send(result);
                                    }
                                    let restore_drained = auto_restore_subscriptions
                                        && subscribe_waiting_for_write.is_empty()
                                        && subscribe_inflight.is_empty();
                                    if !success
                                        && auto_restore_subscriptions
                                        && !request.optional
                                    {
                                        forced_rebuild = Some(format!(
                                            "broker rejected restored subscription {}",
                                            request.topic
                                        ));
                                    } else if (success || tolerate_failure) && restore_drained {
                                        self.announce_subscriptions_ready(
                                            generation,
                                            &mut subscriptions_ready_announced,
                                        )
                                        .await;
                                    }
                                } else {
                                    debug!(pkid = ack.pkid, "received MQTT SUBACK without a tracked request");
                                }
                            }
                            Ok(Event::Outgoing(Outgoing::Publish(pkid))) => {
                                self.heartbeat.end_poll();
                                if let Some(id) = publish_waiting_for_write.pop_front() {
                                    if pkid == 0 {
                                        self.ack_publish(id, &mut store);
                                    } else {
                                        publish_inflight.insert(pkid, id);
                                    }
                                }
                            }
                            Ok(Event::Outgoing(Outgoing::Subscribe(pkid))) => {
                                self.heartbeat.end_poll();
                                if let Some(request) = subscribe_waiting_for_write.pop_front() {
                                    subscribe_inflight.insert(pkid, request);
                                }
                            }
                            Err(error) => {
                                poll_error_count = poll_error_count.saturating_add(1);
                                self.heartbeat.end_poll();
                                self.requeue_publish_attempts(
                                    &mut pending,
                                    &mut publish_waiting_for_write,
                                    &mut publish_inflight,
                                    &store,
                                );
                                let reason = error.to_string();
                                if let rumqttc::ConnectionError::ConnectionRefused(code) = &error {
                                    if connect_refusal_is_credential_failure(code) {
                                        self.backend.invalidate_cached_credential();
                                        // Invalidating the cache is not enough on its
                                        // own: rumqttc reconnects from the same
                                        // `MqttOptions`, so it replays the password
                                        // this worker was built with and can only ever
                                        // be rejected again. The refreshed token on
                                        // disk reaches the broker exactly when a new
                                        // worker is built around it, so exit and let
                                        // the supervisor rebuild — `schedule_restart`
                                        // spaces those out 5s→30s, where the bare
                                        // retry ran flat out at ~100/s.
                                        forced_rebuild.get_or_insert_with(|| {
                                            format!("MQTT credential rejected ({code:?})")
                                        });
                                        // Fire the tick arm on the next pass rather
                                        // than burning up to a full second of retries
                                        // waiting for the deadline it would otherwise
                                        // have.
                                        next_tick = tokio::time::Instant::now();
                                        warn!(?code, "MQTT authentication rejected; invalidating cached credential and rebuilding the worker");
                                    } else {
                                        warn!(?code, "MQTT connection refused for a non-auth reason");
                                    }
                                }
                                if connected {
                                    connected = false;
                                    generation_ready = false;
                                    self.connected.store(false, Ordering::Relaxed);
                                    let _ = self.events_tx.send(WorkerEvent::Supervisor(MqttSupervisorEvent::Disconnected {
                                        generation,
                                        worker_generation: self.worker_generation,
                                        reason: reason.clone(),
                                    })).await;
                                }
                                recovery_started.get_or_insert_with(Instant::now);
                                warn!(
                                    generation,
                                    poll_error_count,
                                    recovery_elapsed_ms = recovery_started
                                        .map(|started| started.elapsed().as_millis() as u64)
                                        .unwrap_or_default(),
                                    %reason,
                                    rebuild_pending = forced_rebuild.is_some(),
                                    "MQTT transport error; recovery in progress"
                                );
                            }
                            Ok(_) => {
                                // Includes PingResp and other protocol-level
                                // traffic. They are poll progress even when
                                // they do not change business state.
                                self.heartbeat.end_poll();
                            }
                        }
                    }
                    _ = &mut tick => {
                        self.heartbeat.touch();
                        // Re-arm before the early-return path below: this arm
                        // only breaks when a rebuild is due, so on every other
                        // tick the loop continues and needs the next deadline.
                        next_tick = tokio::time::Instant::now() + SUPERVISOR_TICK;
                        let recovery_expired = recovery_started
                            .is_some_and(|started| started.elapsed() >= RECOVERY_DEADLINE);
                        let proactive_due = next_proactive_reconnect
                            .is_some_and(|deadline| Instant::now() >= deadline);
                        if forced_rebuild.is_some() || recovery_expired || proactive_due {
                            let forced = forced_rebuild.take();
                            let reason = forced.clone().unwrap_or_else(|| {
                                if recovery_expired {
                                    "recovery deadline exceeded".to_string()
                                } else {
                                    "proactive credential refresh".to_string()
                                }
                            });
                            self.connected.store(false, Ordering::Relaxed);
                            connected = false;
                            generation_ready = false;
                            self.fail_pending_subscriptions(
                                &mut subscribe_waiting_for_write,
                                &mut subscribe_inflight,
                                &reason,
                            );
                            exit_reason = reason;
                            break;
                        }
                    }
                }
            } else {
                tokio::select! {
                    _ = &mut self.stop_rx => {
                        exit_reason = "MQTT worker stop requested".to_string();
                        break;
                    }
                    command = self.command_rx.recv() => {
                        if !self.accept_command(
                            command,
                            false,
                            None,
                            &mut subscriptions,
                            &mut pending,
                            &mut store,
                            &mut subscribe_waiting_for_write,
                        ) {
                            exit_reason = "MQTT worker command channel closed".to_string();
                            break;
                        }
                    }
                    control = self.control_rx.recv() => {
                        match control {
                            Some(WorkerControl::GenerationReady { generation: ready_generation, worker_generation: ready_worker_generation, reply }) => {
                                let accepted = false;
                                warn!(generation = ready_generation, worker_generation = ready_worker_generation, active_generation = generation, "ignored MQTT generation readiness while transport is offline");
                                let _ = reply.send(accepted);
                            }
                            None => {
                                exit_reason = "MQTT worker control channel closed".to_string();
                                break;
                            }
                        }
                    }
                    disposition = self.inbound_disposition_rx.recv() => {
                        if let Some((id, disposition)) = disposition {
                            if let Err(reason) = self.handle_inbound_disposition(
                                id,
                                disposition,
                                &mut store,
                                &mut inbound_retry_attempts,
                                &mut inbound_retry_deadlines,
                            ) {
                                exit_reason = reason;
                                break;
                            }
                        }
                    }
                    _ = &mut tick => {
                        let reason = forced_rebuild
                            .take()
                            .unwrap_or_else(|| "client construction failed".to_string());
                        self.fail_pending_subscriptions(
                            &mut subscribe_waiting_for_write,
                            &mut subscribe_inflight,
                            &reason,
                        );
                        exit_reason = reason;
                        break;
                    }
                }
            }
        }

        self.heartbeat.end_poll();
        self.connected.store(false, Ordering::Relaxed);
        let reason = exit_reason;
        while let Some(publish) = pending.pop_front() {
            self.fail_pending_publish(publish, &reason);
        }
        // A subscription request must never wait forever when the worker is
        // shutting down before a SUBACK arrives.
        self.fail_pending_subscriptions(
            &mut subscribe_waiting_for_write,
            &mut subscribe_inflight,
            &reason,
        );
        self.fail_queued_commands(&reason);
        let _ = self
            .events_tx
            .send(WorkerEvent::Exited {
                worker_generation: self.worker_generation,
                reason,
            })
            .await;
    }

    fn accept_command(
        &self,
        command: Option<MqttCommand>,
        connected: bool,
        mqtt_client: Option<rumqttc::AsyncClient>,
        subscriptions: &mut BTreeMap<String, TrackedSubscription>,
        pending: &mut VecDeque<PendingPublish>,
        store: &mut DurableMqttStore,
        subscribe_waiting_for_write: &mut VecDeque<PendingSubscribe>,
    ) -> bool {
        let Some(command) = command else {
            return false;
        };

        match command {
            MqttCommand::Subscribe {
                topic,
                delivery,
                optional,
                reply,
            } => {
                let qos: QoS = delivery.clone().into();
                subscriptions.insert(
                    topic.clone(),
                    TrackedSubscription { qos, optional },
                );
                let result = if connected {
                    let result = mqtt_client
                        .expect("connected MQTT command must have a client")
                        .try_subscribe(topic.clone(), qos)
                        .map_err(PublisherError::from);
                    if result.is_ok() {
                        subscribe_waiting_for_write.push_back(PendingSubscribe {
                            topic,
                            optional,
                            reply: Some(reply),
                        });
                        return true;
                    }
                    // Queue reject for optional: do not escalate Unavailable.
                    if optional {
                        warn_optional_subscribe_rejected(&topic);
                        Ok(())
                    } else {
                        result
                    }
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
            }
            MqttCommand::Unsubscribe { topic, reply } => {
                subscriptions.remove(&topic);
                let result = if connected {
                    mqtt_client
                        .expect("connected MQTT command must have a client")
                        .try_unsubscribe(topic)
                        .map_err(PublisherError::from)
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
            }
            MqttCommand::Publish {
                topic,
                payload,
                retain,
                delivery,
                reply,
            } => {
                // QoS0 is explicitly transient. Sending it through the
                // durable outbox would turn a best-effort stream delta into a
                // replayable message after a worker restart, violating the
                // AtMostOnce contract. It is accepted only while a transport
                // is connected; a full rumqttc queue is reported to the
                // caller instead of being persisted for later replay.
                if !should_persist_publish(&delivery) {
                    let result = if connected {
                        mqtt_client
                            .expect("connected MQTT command must have a client")
                            .try_publish(topic, delivery.into(), retain, payload)
                            .map_err(PublisherError::from)
                    } else {
                        Err(PublisherError::Unavailable(
                            "MQTT transport is offline; transient publish was dropped".to_string(),
                        ))
                    };
                    let _ = reply.send(result);
                    return true;
                }
                if store.outbox_len() >= DURABLE_QUEUE_CAPACITY
                    || store
                        .outbox_bytes()
                        .saturating_add(payload.len())
                        .saturating_add(topic.len())
                        > DURABLE_QUEUE_MAX_BYTES
                {
                    let _ = reply.send(Err(PublisherError::Unavailable(
                        "MQTT durable outbox is full".to_string(),
                    )));
                    warn!(
                        capacity = DURABLE_QUEUE_CAPACITY,
                        max_bytes = DURABLE_QUEUE_MAX_BYTES,
                        "MQTT durable outbox is full"
                    );
                    return true;
                }
                let publish = DurablePublish {
                    event_id: subscriber::stable_message_id(&IncomingFrame {
                        topic: topic.clone(),
                        payload: payload.clone(),
                        retained: false,
                    }),
                    topic,
                    payload,
                    retain,
                    delivery: StoredDelivery::from(delivery),
                };
                match store.enqueue_publish(publish.clone()) {
                    Ok(id) => {
                        // `publish()` success means the message is durable and
                        // accepted by the supervisor. Broker ACK handling may
                        // happen later, including after a generation rebuild.
                        let _ = reply.send(Ok(()));
                        pending.push_back(PendingPublish {
                            id,
                            publish,
                            reply: None,
                        });
                    }
                    Err(error) => {
                        let _ = reply.send(Err(PublisherError::Unavailable(format!(
                            "could not persist MQTT publish: {error}"
                        ))));
                    }
                }
            }
        }
        true
    }

    fn flush_pending(
        &self,
        client: &mut Option<MqttClient>,
        pending: &mut VecDeque<PendingPublish>,
        waiting_for_write: &mut VecDeque<u64>,
    ) {
        let Some(client) = client.as_ref().map(|client| client.client.clone()) else {
            return;
        };
        // Keep this bounded per loop so a publish burst cannot starve poll().
        for _ in 0..64 {
            let Some(pending_publish) = pending.pop_front() else {
                break;
            };
            if let Err(error) = client.try_publish(
                pending_publish.publish.topic.clone(),
                DeliveryGuarantee::from(pending_publish.publish.delivery).into(),
                pending_publish.publish.retain,
                pending_publish.publish.payload.clone(),
            ) {
                pending.push_front(pending_publish);
                debug!(%error, "MQTT client queue rejected durable outbox item; retrying");
                break;
            }
            waiting_for_write.push_back(pending_publish.id);
        }
    }

    fn requeue_publish_attempts(
        &self,
        pending: &mut VecDeque<PendingPublish>,
        waiting_for_write: &mut VecDeque<u64>,
        inflight: &mut HashMap<u16, u64>,
        store: &DurableMqttStore,
    ) {
        let mut ids = waiting_for_write.drain(..).collect::<Vec<_>>();
        ids.extend(inflight.drain().map(|(_, id)| id));
        ids.sort_unstable();
        for id in ids.into_iter().rev() {
            if let Some(publish) = store.outbox(id).cloned() {
                pending.push_front(PendingPublish {
                    id,
                    publish,
                    reply: None,
                });
            }
        }
    }

    fn handle_inbound_disposition(
        &self,
        id: u64,
        disposition: MqttInboundDisposition,
        store: &mut DurableMqttStore,
        retry_attempts: &mut HashMap<u64, u32>,
        retry_deadlines: &mut HashMap<u64, Instant>,
    ) -> Result<(), String> {
        match disposition {
            MqttInboundDisposition::Ack => {
                retry_attempts.remove(&id);
                retry_deadlines.remove(&id);
                if let Err(error) = store.ack_inbound(id) {
                    error!(%error, id, "failed to ACK durable MQTT inbox item");
                    return Err(format!("{DURABLE_STORE_FAILURE_PREFIX}inbox_ack_failed"));
                }
            }
            MqttInboundDisposition::Retry => {
                let attempt = retry_attempts.entry(id).or_insert(0);
                *attempt = attempt.saturating_add(1);
                let delay = inbound_retry_delay(*attempt);
                retry_deadlines
                    .entry(id)
                    .or_insert_with(|| Instant::now() + delay.min(INBOUND_RETRY_MAX));
                debug!(
                    id,
                    retry_attempt = *attempt,
                    delay_ms = delay.as_millis() as u64,
                    "scheduled durable MQTT inbound retry"
                );
            }
            MqttInboundDisposition::DeadLetter { reason } => {
                retry_attempts.remove(&id);
                retry_deadlines.remove(&id);
                if let Err(error) = store.dead_letter_inbound(id, reason) {
                    error!(%error, id, "failed to move durable MQTT inbox item to dead letter");
                    return Err(format!("{DURABLE_STORE_FAILURE_PREFIX}dead_letter_failed"));
                }
            }
        }
        Ok(())
    }

    fn flush_due_inbound_retries(
        &self,
        store: &DurableMqttStore,
        staging: &mut VecDeque<MqttInbound>,
        retry_deadlines: &mut HashMap<u64, Instant>,
    ) {
        let now = Instant::now();
        let due = retry_deadlines
            .iter()
            .filter_map(|(&id, &deadline)| (deadline <= now).then_some(id))
            .collect::<Vec<_>>();
        for id in due {
            retry_deadlines.remove(&id);
            let Some(item) = store.inbound(id) else {
                continue;
            };
            if staging.len() >= INBOUND_STAGING_CAPACITY {
                warn!(
                    capacity = INBOUND_STAGING_CAPACITY,
                    id, "MQTT inbound staging is full; durable item will replay after restart"
                );
                retry_deadlines.insert(id, now + INBOUND_RETRY_MAX);
                continue;
            }
            staging.push_back(MqttInbound {
                id,
                frame: IncomingFrame {
                    topic: item.topic.clone(),
                    payload: item.payload.clone(),
                    retained: item.retained,
                },
            });
        }
    }

    fn ack_publish(&self, id: u64, store: &mut DurableMqttStore) {
        if let Err(error) = store.ack_publish(id) {
            // Keep the item in the log if the ACK record could not be synced;
            // replaying once is safer than silently losing a publish.
            warn!(%error, id, "failed to ACK durable MQTT outbox item");
        }
    }

    fn flush_inbound(&self, staging: &mut VecDeque<MqttInbound>) {
        while let Some(frame) = staging.pop_front() {
            match self.inbound_tx.try_send(frame) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(frame)) => {
                    staging.push_front(frame);
                    break;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
    }

    async fn announce_subscriptions_ready(&self, generation: u64, announced: &mut bool) {
        if *announced {
            return;
        }
        *announced = true;
        let _ = self
            .events_tx
            .send(WorkerEvent::Supervisor(
                MqttSupervisorEvent::SubscriptionsReady {
                    generation,
                    worker_generation: self.worker_generation,
                },
            ))
            .await;
        info!(
            generation,
            "MQTT subscriptions restored and SUBACKs received"
        );
    }

    fn fail_command(&self, command: MqttCommand, reason: &str) {
        let error = PublisherError::Unavailable(reason.to_string());
        match command {
            MqttCommand::Publish { reply, .. }
            | MqttCommand::Subscribe { reply, .. }
            | MqttCommand::Unsubscribe { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }

    fn fail_pending_publish(&self, publish: PendingPublish, reason: &str) {
        if let Some(reply) = publish.reply {
            let _ = reply.send(Err(PublisherError::Unavailable(reason.to_string())));
        }
    }

    fn fail_pending_subscriptions(
        &self,
        waiting_for_write: &mut VecDeque<PendingSubscribe>,
        inflight: &mut HashMap<u16, PendingSubscribe>,
        reason: &str,
    ) {
        for request in waiting_for_write
            .drain(..)
            .chain(inflight.drain().map(|(_, request)| request))
        {
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(PublisherError::Unavailable(format!(
                    "MQTT subscription interrupted: {reason}"
                ))));
            }
        }
    }

    fn fail_queued_commands(&mut self, reason: &str) {
        while let Ok(command) = self.command_rx.try_recv() {
            self.fail_command(command, reason);
        }
    }
}

struct PendingPublish {
    id: u64,
    publish: DurablePublish,
    /// New publishes are acknowledged when durably accepted, so this is only
    /// populated by future callers that choose broker-ACK completion.
    reply: Option<oneshot::Sender<Result<(), PublisherError>>>,
}

struct PendingSubscribe {
    topic: String,
    optional: bool,
    reply: Option<oneshot::Sender<Result<(), PublisherError>>>,
}

async fn mqtt_watchdog(
    heartbeat: Arc<MqttHeartbeat>,
    control_tx: mpsc::Sender<MqttControl>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut interval = tokio::time::interval(SUPERVISOR_TICK);
    let mut last_stall_warning = None::<Instant>;
    let mut rebuild_requested_at = None::<Instant>;
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = interval.tick() => {
                let now = MqttHeartbeat::now_ms();
                let progress_age = now.saturating_sub(heartbeat.last_progress_ms.load(Ordering::Relaxed));
                if progress_age >= WORKER_STALL_WARN.as_millis() as u64
                    && last_stall_warning.map_or(true, |at| at.elapsed() >= WORKER_STALL_WARN)
                {
                    warn!(age_ms = progress_age, "MQTT worker heartbeat is delayed; this is a task-liveness warning, not an idle-connection failure");
                    last_stall_warning = Some(Instant::now());
                }

                let pending_since = heartbeat.poll_pending_since_ms.load(Ordering::Relaxed);
                let pending_age = now.saturating_sub(pending_since);
                if pending_since != 0 && pending_age >= POLL_PENDING_WARN.as_millis() as u64 {
                    debug!(age_ms = pending_age, "MQTT eventloop poll is pending; an idle connection is expected to have no MQTT events");
                }
                let (rebuild_due, reason, age_ms) = if pending_since != 0
                    && pending_age >= POLL_PENDING_REBUILD.as_millis() as u64
                {
                    (
                        true,
                        "eventloop poll pending beyond watchdog bound",
                        pending_age,
                    )
                } else if progress_age >= POLL_PENDING_REBUILD.as_millis() as u64 {
                    (
                        true,
                        "MQTT worker heartbeat stalled beyond watchdog bound",
                        progress_age,
                    )
                } else {
                    (false, "", 0)
                };
                if watchdog_rebuild_request_allowed(rebuild_due, &mut rebuild_requested_at) {
                    warn!(age_ms, %reason, "MQTT worker exceeded the watchdog recovery bound; requesting controlled generation rebuild");
                    if control_tx
                        .send(MqttControl::Rebuild {
                            reason: reason.to_string(),
                            fence: None,
                        })
                        .await
                        .is_ok()
                    {
                        rebuild_requested_at = Some(Instant::now());
                    }
                }
            }
        }
    }
}

fn load_pending_publishes(store: &DurableMqttStore) -> VecDeque<PendingPublish> {
    store
        .pending_outbox()
        .map(|(id, publish)| PendingPublish {
            id,
            publish: publish.clone(),
            reply: None,
        })
        .collect()
}

fn durable_inbox_blocked(store: &DurableMqttStore) -> bool {
    store.inbound_len() >= DURABLE_QUEUE_CAPACITY || store.inbox_bytes() >= DURABLE_QUEUE_MAX_BYTES
}

fn proactive_reconnect_deadline(expires_at_epoch: Option<i64>) -> Option<Instant> {
    let delay = proactive_reconnect_delay(expires_at_epoch);
    (!delay.is_zero()).then(|| Instant::now() + delay)
}

fn load_pending_inbound(store: &DurableMqttStore) -> VecDeque<MqttInbound> {
    store
        .pending_inbound()
        .map(|(id, item)| MqttInbound {
            id,
            frame: IncomingFrame {
                topic: item.topic.clone(),
                payload: item.payload.clone(),
                retained: item.retained,
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_generation_is_rejected_by_the_readiness_fence() {
        assert!(generation_is_current(7, 7));
        assert!(!generation_is_current(7, 6));
        assert!(!generation_is_current(7, 8));
        assert!(is_current_ready_generation(true, 7, 7, Some(7), 7, 7));
        assert!(!is_current_ready_generation(true, 7, 7, Some(7), 6, 7));
        assert!(!is_current_ready_generation(true, 7, 7, None, 7, 7));
        assert!(!is_current_ready_generation(false, 7, 7, Some(7), 7, 7));
    }

    #[test]
    fn fenced_rebuild_requests_cannot_target_a_new_worker() {
        assert!(rebuild_fence_matches_generation(true, 11, 4, Some((11, 4))));
        assert!(!rebuild_fence_matches_generation(
            true,
            12,
            5,
            Some((11, 4))
        ));
        assert!(!rebuild_fence_matches_generation(
            false,
            11,
            4,
            Some((11, 4))
        ));
        assert!(rebuild_fence_matches_generation(false, 99, 99, None));
    }

    #[test]
    fn only_reliable_publish_guarantees_enter_the_durable_outbox() {
        assert!(!should_persist_publish(&DeliveryGuarantee::AtMostOnce));
        assert!(should_persist_publish(&DeliveryGuarantee::AtLeastOnce));
        assert!(should_persist_publish(&DeliveryGuarantee::ExactlyOnce));
    }

    #[test]
    fn permanent_durable_store_failure_is_distinct_from_transport_failure() {
        assert!(is_durable_store_failure("durable_store:open_failed"));
        assert!(is_durable_store_failure(
            "durable_store:inbound_persistence_failed"
        ));
        assert!(!is_durable_store_failure("MQTT connection closed"));
        assert!(recovery_may_retry_storage(
            MqttRecoveryReason::UserRequested
        ));
        assert!(!recovery_may_retry_storage(
            MqttRecoveryReason::NetworkOnline
        ));
        assert!(!recovery_may_retry_storage(
            MqttRecoveryReason::VisibilityResume
        ));
    }

    #[test]
    fn stale_worker_events_cannot_reopen_a_previous_generation() {
        assert!(worker_event_matches_generation(
            8,
            &MqttSupervisorEvent::TransportConnected {
                generation: 3,
                worker_generation: 8,
            }
        ));
        assert!(!worker_event_matches_generation(
            8,
            &MqttSupervisorEvent::SubscriptionsReady {
                generation: 2,
                worker_generation: 7,
            }
        ));
        assert!(worker_event_matches_generation(
            8,
            &MqttSupervisorEvent::Terminated
        ));
    }

    #[test]
    fn heartbeat_tracks_poll_pending_separately_from_task_progress() {
        let heartbeat = MqttHeartbeat::default();
        heartbeat.touch();
        assert_eq!(heartbeat.poll_pending_since_ms.load(Ordering::Relaxed), 0);
        heartbeat.begin_poll();
        assert!(heartbeat.poll_pending_since_ms.load(Ordering::Relaxed) > 0);
        heartbeat.touch();
        assert!(heartbeat.last_progress_ms.load(Ordering::Relaxed) > 0);
        heartbeat.end_poll();
        assert_eq!(heartbeat.poll_pending_since_ms.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn credential_refusals_force_a_rebuild_and_other_refusals_do_not() {
        use rumqttc::mqttbytes::v4::ConnectReturnCode;

        // A JWT broker rejects an expired token as BadUserNamePassword and an
        // unverifiable signature as NotAuthorized. Both are fixed by a new
        // token, so both must take the rebuild path — leaving either one on
        // rumqttc's own reconnect replays the dead password forever.
        assert!(connect_refusal_is_credential_failure(
            &ConnectReturnCode::BadUserNamePassword
        ));
        assert!(connect_refusal_is_credential_failure(
            &ConnectReturnCode::NotAuthorized
        ));

        for code in [
            ConnectReturnCode::RefusedProtocolVersion,
            ConnectReturnCode::BadClientId,
            ConnectReturnCode::ServiceUnavailable,
        ] {
            assert!(
                !connect_refusal_is_credential_failure(&code),
                "{code:?} is not a credential problem; a fresh token cannot fix it"
            );
        }
    }

    #[test]
    fn restart_backoff_is_capped_after_repeated_worker_failures() {
        assert_eq!(restart_delay(1), Duration::from_secs(5));
        assert_eq!(restart_delay(2), Duration::from_secs(10));
        assert_eq!(restart_delay(3), Duration::from_secs(20));
        assert_eq!(restart_delay(4), Duration::from_secs(30));
        assert_eq!(restart_delay(20), Duration::from_secs(30));
    }

    #[test]
    fn restart_deadline_never_moves_earlier_than_retry_window() {
        let now = Instant::now();
        let mut next_restart = now + Duration::from_secs(20);
        let mut restart_failures = 0;

        schedule_restart_at(&mut next_restart, &mut restart_failures, now);

        assert_eq!(restart_failures, 1);
        assert_eq!(next_restart, now + Duration::from_secs(20));
    }

    #[test]
    fn repeated_restart_requests_use_monotonic_exponential_backoff() {
        let now = Instant::now();
        let mut next_restart = now;
        let mut restart_failures = 0;

        schedule_restart_at(&mut next_restart, &mut restart_failures, now);
        assert_eq!(next_restart, now + Duration::from_secs(5));

        schedule_restart_at(
            &mut next_restart,
            &mut restart_failures,
            now + Duration::from_millis(1),
        );
        assert!(next_restart >= now + Duration::from_secs(10));

        schedule_restart_at(
            &mut next_restart,
            &mut restart_failures,
            now + Duration::from_millis(2),
        );
        assert!(next_restart >= now + Duration::from_secs(20));

        schedule_restart_at(
            &mut next_restart,
            &mut restart_failures,
            now + Duration::from_millis(3),
        );
        assert!(next_restart >= now + Duration::from_secs(30));
        assert_eq!(restart_failures, 4);
    }

    #[test]
    fn watchdog_rebuild_gate_rearms_after_recovery() {
        let mut requested_at = None;

        assert!(watchdog_rebuild_request_allowed(true, &mut requested_at));
        requested_at = Some(Instant::now());
        assert!(!watchdog_rebuild_request_allowed(true, &mut requested_at));

        assert!(!watchdog_rebuild_request_allowed(false, &mut requested_at));
        assert!(requested_at.is_none());
        assert!(watchdog_rebuild_request_allowed(true, &mut requested_at));
    }

    #[test]
    fn wall_clock_wake_gap_is_only_triggered_once_per_observation() {
        let threshold = WAKE_GAP_THRESHOLD.as_millis() as u64;
        assert!(!wake_gap_requires_recovery(1_000, 1_000 + threshold - 1));
        assert!(wake_gap_requires_recovery(1_000, 1_000 + threshold));

        // The supervisor advances its observation timestamp after handling the
        // gap. A second pass at the same wall-clock value must not create a
        // second recovery edge.
        let observed = 1_000 + threshold;
        assert!(!wake_gap_requires_recovery(observed, observed));
    }

    #[test]
    fn proactive_refresh_window_does_not_trigger_a_rebuild_loop() {
        let near_expiry = crate::backend::epoch_secs_now() + 60;
        assert!(proactive_reconnect_deadline(Some(near_expiry)).is_none());
        assert!(proactive_reconnect_deadline(None).is_some());
    }

    #[test]
    fn inbound_retry_backoff_is_bounded_and_monotonic() {
        assert_eq!(inbound_retry_delay(1), Duration::from_secs(1));
        assert_eq!(inbound_retry_delay(2), Duration::from_secs(2));
        assert_eq!(inbound_retry_delay(3), Duration::from_secs(4));
        assert_eq!(inbound_retry_delay(5), Duration::from_secs(16));
        assert_eq!(inbound_retry_delay(6), Duration::from_secs(30));
        assert_eq!(inbound_retry_delay(100), Duration::from_secs(30));
    }

    #[test]
    fn recovery_signal_channel_keeps_only_one_pending_request() {
        let (handle, mut receiver) = MqttRecoveryHandle::channel();
        let (reply, _response) = oneshot::channel();
        handle
            .tx
            .try_send(MqttRecoveryRequest {
                reason: MqttRecoveryReason::NetworkOnline,
                request_id: "one".into(),
                reply,
                coalescing: handle.coalescing.clone(),
            })
            .expect("first recovery signal should fit");
        let (reply, _response) = oneshot::channel();
        assert!(handle
            .tx
            .try_send(MqttRecoveryRequest {
                reason: MqttRecoveryReason::VisibilityResume,
                request_id: "two".into(),
                reply,
                coalescing: handle.coalescing.clone(),
            })
            .is_err());
        let first = receiver.try_recv().expect("pending signal");
        assert_eq!(first.request_id, "one");
    }

    #[tokio::test]
    async fn concurrent_recovery_requests_are_accepted_by_one_recovery_edge() {
        let (handle, mut receiver) = MqttRecoveryHandle::channel();
        let first_handle = handle.clone();
        let first = tokio::spawn(async move {
            first_handle
                .request(MqttRecoveryReason::NetworkOnline)
                .await
                .unwrap()
        });

        let request = receiver.recv().await.expect("first recovery request");
        let second = handle
            .request(MqttRecoveryReason::VisibilityResume)
            .await
            .unwrap();
        assert!(second.accepted);
        assert!(matches!(second.outcome, MqttRecoveryOutcome::Recovering));
        assert!(receiver.try_recv().is_err());

        request
            .reply
            .send(MqttRecoveryAccepted {
                accepted: true,
                outcome: MqttRecoveryOutcome::Recovering,
                request_id: request.request_id,
                worker_generation: None,
            })
            .unwrap();
        assert!(matches!(
            first.await.unwrap().outcome,
            MqttRecoveryOutcome::Recovering
        ));
    }

    #[test]
    fn stale_worker_exit_events_are_rejected_by_generation() {
        assert!(!worker_exit_matches_generation(2, 1));
        assert!(worker_exit_matches_generation(2, 2));
    }

    #[test]
    fn optional_suback_failure_does_not_force_rebuild() {
        assert_eq!(
            suback_failure_action(true),
            SubackFailureAction::Tolerate
        );
        assert_eq!(
            suback_failure_action(false),
            SubackFailureAction::ForceRebuild
        );
    }

    /// Optional reject must not schedule a rebuild; required still does.
    /// Mirrors the CONNACK restore / live-subscribe decision used above.
    #[test]
    fn rejected_optional_subscribe_skips_forced_rebuild_while_required_still_rebuilds() {
        fn forced_rebuild_reason(
            optional: bool,
            auto_restore: bool,
            topic: &str,
        ) -> Option<String> {
            if !auto_restore {
                return None;
            }
            match suback_failure_action(optional) {
                SubackFailureAction::Tolerate => None,
                SubackFailureAction::ForceRebuild => {
                    Some(format!("broker rejected restored subscription {topic}"))
                }
            }
        }

        assert_eq!(
            forced_rebuild_reason(true, true, "amux/t/sync/+"),
            None,
            "optional sync/+ deny must not rebuild the worker (#1073 auth-reject context)"
        );
        assert_eq!(
            forced_rebuild_reason(false, true, "amux/t/actor/rpc/req"),
            Some("broker rejected restored subscription amux/t/actor/rpc/req".into())
        );
        assert_eq!(
            forced_rebuild_reason(false, false, "amux/t/actor/rpc/req"),
            None,
            "live (non-restore) path escalates via reply Err, not forced_rebuild"
        );
    }

    #[tokio::test]
    async fn stable_publisher_optional_subscribe_sets_optional_flag() {
        let (publisher, mut commands) = MqttPublisher::channel();
        let task = tokio::spawn(async move {
            publisher
                .subscribe_optional("amux/team/sync/+", DeliveryGuarantee::AtLeastOnce)
                .await
        });

        let command = commands.recv().await.expect("subscribe command");
        match command {
            MqttCommand::Subscribe {
                topic,
                optional,
                reply,
                ..
            } => {
                assert_eq!(topic, "amux/team/sync/+");
                assert!(optional);
                reply.send(Ok(())).expect("reply");
            }
            _ => panic!("unexpected command"),
        }
        assert!(task.await.expect("task").is_ok());
    }

    #[tokio::test]
    async fn stable_publisher_routes_commands_without_exposing_client_generation() {
        let (publisher, mut commands) = MqttPublisher::channel();
        let task = tokio::spawn(async move {
            publisher
                .publish(
                    "amux/team/actor/state",
                    vec![1, 2, 3],
                    true,
                    DeliveryGuarantee::AtLeastOnce,
                )
                .await
        });

        let command = commands.recv().await.expect("publish command");
        match command {
            MqttCommand::Publish {
                topic,
                payload,
                retain,
                delivery,
                reply,
            } => {
                assert_eq!(topic, "amux/team/actor/state");
                assert_eq!(payload, vec![1, 2, 3]);
                assert!(retain);
                assert_eq!(delivery, DeliveryGuarantee::AtLeastOnce);
                reply.send(Ok(())).expect("reply receiver is alive");
            }
            _ => panic!("unexpected command"),
        }

        assert!(task.await.expect("publisher task").is_ok());
    }

    #[tokio::test]
    async fn stable_publisher_reports_supervisor_shutdown() {
        let (publisher, commands) = MqttPublisher::channel();
        drop(commands);

        let result = publisher
            .publish(
                "amux/team/actor/state",
                vec![],
                false,
                DeliveryGuarantee::AtMostOnce,
            )
            .await;

        assert!(matches!(result, Err(PublisherError::Unavailable(_))));
    }
}
