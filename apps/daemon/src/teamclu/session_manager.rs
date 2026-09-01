use crate::backend::Backend;
use crate::mqtt::Topics;
use crate::proto::teamclu::{self, RpcRequest, RpcResponse};
use crate::teamclu::{
    IdeaStore, LivePublisher, MessageStore, NotifyPublisher, RpcServer, StoredClaim, StoredIdea,
    StoredMessage, StoredParticipant, StoredSession, StoredSubmission, TeamcluSessionStore,
};
use chrono::Utc;
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use teamclu_transport::{DeliveryGuarantee, MessagePublisher};
use tracing::{info, warn};
use uuid::Uuid;

const RECENT_EVENT_CACHE_LIMIT: usize = 512;

/// The "已经处理过这条" gate, shared by everything that can introduce a message
/// into a session.
///
/// It used to be two plain fields on `SessionManager`, reachable only from the
/// daemon's own loop. The gateway writes messages too, and it has to close this
/// gate before broadcasting them — otherwise its own `message.created` arrives
/// back through `route_session_message`, matches the agent mention, and runs
/// the turn a second time.
#[derive(Clone, Default)]
pub struct MessageDedup {
    inner: Arc<std::sync::Mutex<DedupState>>,
}

#[derive(Default)]
struct DedupState {
    keys: HashSet<String>,
    order: VecDeque<String>,
}

impl MessageDedup {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` when this is the first claim — i.e. the caller should process
    /// (or, for a publisher, that nothing else has published it yet).
    pub fn claim_message(&self, session_id: &str, message_id: &str) -> bool {
        if message_id.is_empty() {
            return true;
        }
        self.claim_key(format!("message:{session_id}:{message_id}"))
    }

    fn claim_key(&self, key: String) -> bool {
        if key.is_empty() {
            return true;
        }
        let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if st.keys.contains(&key) {
            return false;
        }
        st.keys.insert(key.clone());
        st.order.push_back(key);
        while st.order.len() > RECENT_EVENT_CACHE_LIMIT {
            if let Some(oldest) = st.order.pop_front() {
                st.keys.remove(&oldest);
            }
        }
        true
    }
}

pub struct SessionManager {
    topics: Topics,
    client: Arc<dyn MessagePublisher>,
    live_publisher: LivePublisher,
    notify_publisher: NotifyPublisher,
    #[allow(dead_code)]
    rpc_server: RpcServer,
    pub(crate) sessions: TeamcluSessionStore,
    sessions_path: PathBuf,
    pub(crate) config_dir: PathBuf,
    config_actor_id: String,
    team_id: String,
    actor_id: Option<String>,
    recent_events: MessageDedup,
    subscribed_live_sessions: BTreeSet<String>,
    #[cfg(test)]
    skip_live_subscription_io: bool,
}

impl SessionManager {
    pub fn new(
        client: Arc<dyn MessagePublisher>,
        team_id: &str,
        config_actor_id: &str,
        actor_id: Option<String>,
        config_dir: PathBuf,
    ) -> crate::error::Result<Self> {
        let topics = Topics::new(team_id, config_actor_id);
        let live_publisher = LivePublisher::new(
            client.clone(),
            team_id.to_string(),
            config_actor_id.to_string(),
        );
        let notify_publisher = NotifyPublisher::new(client.clone(), team_id.to_string());
        let rpc_server = RpcServer::new(
            client.clone(),
            team_id.to_string(),
            config_actor_id.to_string(),
        );
        // Before the first read: sessions/messages/ideas written by a
        // pre-rebrand daemon live one directory over.
        let sessions_path = TeamcluSessionStore::default_path(&config_dir);
        let sessions = TeamcluSessionStore::load(&sessions_path)?;

        Ok(Self {
            topics,
            client,
            live_publisher,
            notify_publisher,
            rpc_server,
            sessions,
            sessions_path,
            config_dir,
            config_actor_id: config_actor_id.to_string(),
            team_id: team_id.to_string(),
            actor_id,
            recent_events: MessageDedup::new(),
            subscribed_live_sessions: BTreeSet::new(),
            #[cfg(test)]
            skip_live_subscription_io: false,
        })
    }

    /// A clone of the live publisher, for code outside `SessionManager` that
    /// has to broadcast on `session/{id}/live` — the gateway store, which
    /// writes messages the daemon itself never routed.
    pub fn live_publisher_handle(&self) -> LivePublisher {
        self.live_publisher.clone()
    }

    /// The shared "already handled this message" gate. A publisher outside the
    /// daemon loop has to be able to claim an id *before* publishing, or the
    /// loopback copy of its own message comes back through
    /// `route_session_message` and starts a second turn.
    pub fn message_dedup(&self) -> MessageDedup {
        self.recent_events.clone()
    }

    /// Mirror every session/live publish into the local fast-path broadcast
    /// (`GET /v1/live/events` SSE). Called after construction so the many
    /// existing `SessionManager::new` call sites stay unchanged.
    pub fn set_local_tee(
        &mut self,
        tx: tokio::sync::broadcast::Sender<crate::teamclu::live::LiveTeeEvent>,
    ) {
        self.live_publisher.set_local_tee(tx);
    }

    /// Subscribe to all relevant teamclu topics.
    pub async fn subscribe_all(&mut self) -> crate::error::Result<()> {
        for topic in self.base_subscription_topics() {
            self.client
                .subscribe(&topic, DeliveryGuarantee::AtLeastOnce)
                .await?;
        }
        // MQTT uses clean sessions, so a reconnect drops broker-side
        // session/live subscriptions even though this in-memory set still
        // contains them. Force `refresh_membership_subscriptions` to reissue
        // every live SUBSCRIBE after `DaemonServer` calls `subscribe_all()`.
        self.subscribed_live_sessions.clear();
        self.refresh_membership_subscriptions().await?;

        Ok(())
    }

    /// Handle a pre-parsed RPC request. Only dispatches session/idea-scoped methods.
    ///
    /// Caller is responsible for decoding the wire payload and publishing the response.
    /// Non-session methods are dispatched by `DaemonServer::handle_rpc_request` directly.
    ///
    /// `host_primary_agent_id` is intentionally ignored for session creation.
    /// A session should only gain `primary_agent_id` once an agent actually
    /// joins it, rather than inheriting whichever local agent happened to be
    /// running when the session was created.
    pub async fn handle_rpc_method(
        &mut self,
        request: RpcRequest,
        primary_agent_id: Option<String>,
    ) -> RpcResponse {
        let request_id = request.request_id.clone();
        match request.method.clone() {
            Some(teamclu::rpc_request::Method::CreateSession(r)) => {
                self.handle_create_session(&request, r, primary_agent_id)
                    .await
            }
            Some(teamclu::rpc_request::Method::FetchSession(r)) => {
                self.handle_fetch_session(&request, r).await
            }
            Some(teamclu::rpc_request::Method::FetchSessionMessages(r)) => {
                self.handle_fetch_session_messages(&request, r).await
            }
            Some(teamclu::rpc_request::Method::JoinSession(r)) => {
                self.handle_join_session(&request, r).await
            }
            Some(teamclu::rpc_request::Method::AddParticipant(r)) => {
                self.handle_add_participant(&request, r).await
            }
            Some(teamclu::rpc_request::Method::RemoveParticipant(r)) => {
                self.handle_remove_participant(&request, r).await
            }
            Some(teamclu::rpc_request::Method::CreateIdea(r)) => {
                self.handle_create_idea(&request, r).await
            }
            Some(teamclu::rpc_request::Method::ClaimIdea(r)) => {
                self.handle_claim_idea(&request, r).await
            }
            Some(teamclu::rpc_request::Method::SubmitIdea(r)) => {
                self.handle_submit_idea(&request, r).await
            }
            Some(teamclu::rpc_request::Method::UpdateIdea(r)) => {
                self.handle_update_idea(&request, r).await
            }
            other => {
                // Non-session methods are dispatched by DaemonServer directly,
                // not SessionManager. If we land here, the caller routed wrong.
                warn!(
                    ?other,
                    "SessionManager got non-session RPC method; routing bug"
                );
                RpcResponse {
                    request_id,
                    success: false,
                    error: "method not handled by SessionManager".to_string(),
                    requester_client_id: request.requester_client_id,
                    requester_actor_id: request.requester_actor_id,
                    result: None,
                }
            }
        }
    }

    // --- RPC Handlers ---

    async fn handle_create_session(
        &mut self,
        req: &RpcRequest,
        r: teamclu::CreateSessionRequest,
        _host_primary_agent_id: Option<String>,
    ) -> RpcResponse {
        let session_id = Uuid::new_v4().to_string();

        let session = StoredSession {
            session_id: session_id.clone(),
            team_id: r.team_id.clone(),
            title: r.title.clone(),
            created_by: if !r.sender_actor_id.is_empty() {
                r.sender_actor_id.clone()
            } else {
                req.requester_actor_id.clone()
            },
            created_at: Utc::now(),
            summary: r.summary.clone(),
            idea_id: r.idea_id.clone(),
            participants: vec![],
            primary_agent_id: String::new(),
        };

        self.sessions.upsert(session);
        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_create_session: failed to save sessions: {}", e);
        }

        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %session_id,
                "handle_create_session: failed to refresh membership subscriptions: {}",
                e
            );
        }

        let session_info = self.sessions.to_proto_session_info(&session_id);
        info!(session_id = %session_id, "session created");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: session_info.map(|s| teamclu::rpc_response::Result::SessionInfo(s)),
        }
    }

    async fn handle_fetch_session(
        &self,
        req: &RpcRequest,
        r: teamclu::FetchSessionRequest,
    ) -> RpcResponse {
        match self.sessions.to_proto_session_info(&r.session_id) {
            Some(info) => RpcResponse {
                request_id: req.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                result: Some(teamclu::rpc_response::Result::SessionInfo(info)),
            },
            None => RpcResponse {
                request_id: req.request_id.clone(),
                success: false,
                error: format!("session {} not found", r.session_id),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                result: None,
            },
        }
    }

    async fn handle_fetch_session_messages(
        &self,
        req: &RpcRequest,
        r: teamclu::FetchSessionMessagesRequest,
    ) -> RpcResponse {
        let store = match MessageStore::load(&self.config_dir, &r.session_id) {
            Ok(store) => store,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        let (messages, has_more, next_before_created_at) = store.page_before(
            r.before_created_at,
            if r.page_size == 0 { 100 } else { r.page_size },
        );
        let page = teamclu::SessionMessagePage {
            session_id: r.session_id,
            messages: messages.into_iter().map(MessageStore::to_proto).collect(),
            has_more,
            next_before_created_at,
        };

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: Some(teamclu::rpc_response::Result::SessionMessagePage(page)),
        }
    }

    async fn handle_join_session(
        &mut self,
        req: &RpcRequest,
        r: teamclu::JoinSessionRequest,
    ) -> RpcResponse {
        let participant = match r.participant {
            Some(p) => p,
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: "missing participant".to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        let actor_type = actor_type_to_string(participant.actor_type);
        let proto_participant = participant.clone();
        let stored_participant = StoredParticipant {
            actor_id: participant.actor_id.clone(),
            actor_type,
            display_name: participant.display_name.clone(),
            joined_at: Utc::now(),
        };

        match self.sessions.find_by_id_mut(&r.session_id) {
            Some(session) => {
                // Only add if not already a participant
                if !session
                    .participants
                    .iter()
                    .any(|p| p.actor_id == participant.actor_id)
                {
                    session.participants.push(stored_participant);
                }
                if participant_is_agent(participant.actor_type)
                    && session.primary_agent_id.is_empty()
                {
                    session.primary_agent_id = participant.actor_id.clone();
                }
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("session {} not found", r.session_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        }

        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_join_session: failed to save sessions: {}", e);
        }
        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %r.session_id,
                "handle_join_session: failed to refresh membership subscriptions: {}",
                e
            );
        }
        if let Err(e) = self
            .live_publisher
            .publish_presence_event("presence.joined", &r.session_id, &proto_participant)
            .await
        {
            warn!(
                "handle_join_session: failed to publish live presence event: {}",
                e
            );
        }
        for target_actor_id in
            self.membership_refresh_targets(&r.session_id, Some(&req.requester_actor_id))
        {
            if let Err(e) = self
                .notify_publisher
                .publish_membership_refresh(&target_actor_id, &r.session_id, "participant_joined")
                .await
            {
                warn!(
                    target_actor_id = %target_actor_id,
                    "handle_join_session: failed to publish notify event: {}",
                    e
                );
            }
        }

        let session_info = self.sessions.to_proto_session_info(&r.session_id);
        info!(session_id = %r.session_id, actor_id = %participant.actor_id, "participant joined session");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: session_info.map(|s| teamclu::rpc_response::Result::SessionInfo(s)),
        }
    }

    async fn handle_add_participant(
        &mut self,
        req: &RpcRequest,
        r: teamclu::AddParticipantRequest,
    ) -> RpcResponse {
        let participant = match r.participant {
            Some(p) => p,
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: "missing participant".to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        let actor_type = actor_type_to_string(participant.actor_type);
        let proto_participant = participant.clone();
        let stored_participant = StoredParticipant {
            actor_id: participant.actor_id.clone(),
            actor_type,
            display_name: participant.display_name.clone(),
            joined_at: Utc::now(),
        };

        match self.sessions.find_by_id_mut(&r.session_id) {
            Some(session) => {
                if !session
                    .participants
                    .iter()
                    .any(|p| p.actor_id == participant.actor_id)
                {
                    session.participants.push(stored_participant);
                }
                if participant_is_agent(participant.actor_type)
                    && session.primary_agent_id.is_empty()
                {
                    session.primary_agent_id = participant.actor_id.clone();
                }
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("session {} not found", r.session_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        }

        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_add_participant: failed to save sessions: {}", e);
        }
        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %r.session_id,
                "handle_add_participant: failed to refresh membership subscriptions: {}",
                e
            );
        }
        if let Err(e) = self
            .live_publisher
            .publish_presence_event("presence.joined", &r.session_id, &proto_participant)
            .await
        {
            warn!(
                "handle_add_participant: failed to publish live presence event: {}",
                e
            );
        }
        for target_actor_id in
            self.membership_refresh_targets(&r.session_id, Some(&req.requester_actor_id))
        {
            if let Err(e) = self
                .notify_publisher
                .publish_membership_refresh(&target_actor_id, &r.session_id, "participant_added")
                .await
            {
                warn!(
                    target_actor_id = %target_actor_id,
                    "handle_add_participant: failed to publish notify event: {}",
                    e
                );
            }
        }

        let session_info = self.sessions.to_proto_session_info(&r.session_id);
        info!(session_id = %r.session_id, actor_id = %participant.actor_id, "participant added to session");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: session_info.map(|s| teamclu::rpc_response::Result::SessionInfo(s)),
        }
    }

    async fn handle_remove_participant(
        &mut self,
        req: &RpcRequest,
        r: teamclu::RemoveParticipantRequest,
    ) -> RpcResponse {
        let removed_participant = match self.sessions.find_by_id_mut(&r.session_id) {
            Some(session) => {
                let removed = session
                    .participants
                    .iter()
                    .find(|p| p.actor_id == r.actor_id)
                    .cloned();
                session.participants.retain(|p| p.actor_id != r.actor_id);
                removed
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("session {} not found", r.session_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_remove_participant: failed to save sessions: {}", e);
        }
        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %r.session_id,
                "handle_remove_participant: failed to refresh membership subscriptions: {}",
                e
            );
        }
        if let Some(participant) = removed_participant.as_ref() {
            let proto_participant = stored_participant_to_proto(participant);
            if let Err(e) = self
                .live_publisher
                .publish_presence_event("presence.left", &r.session_id, &proto_participant)
                .await
            {
                warn!(
                    "handle_remove_participant: failed to publish live presence event: {}",
                    e
                );
            }
        }
        for target_actor_id in
            self.membership_refresh_targets(&r.session_id, Some(&req.requester_actor_id))
        {
            if let Err(e) = self
                .notify_publisher
                .publish_membership_refresh(&target_actor_id, &r.session_id, "participant_removed")
                .await
            {
                warn!(
                    target_actor_id = %target_actor_id,
                    "handle_remove_participant: failed to publish notify event: {}",
                    e
                );
            }
        }

        let session_info = self.sessions.to_proto_session_info(&r.session_id);
        info!(session_id = %r.session_id, actor_id = %r.actor_id, "participant removed from session");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: session_info.map(|s| teamclu::rpc_response::Result::SessionInfo(s)),
        }
    }

    /// Synthesise a local `StoredSession` from a backend fetch, populate
    /// participants, and trigger a `refresh_membership_subscriptions` so the
    /// daemon subscribes to `session/{sid}/live` if it is a participant.
    ///
    /// iOS creates collab sessions by writing directly to the remote backend
    /// `sessions`/`session_participants`; the daemon only learns about them
    /// via this path (called from `apply_start_runtime`). Without this,
    /// inbound `message.created` events on `session/{sid}/live` are silently
    /// dropped because the daemon never subscribed.
    ///
    /// `session_participants` doesn't carry an explicit actor_type. We stamp
    /// the local daemon actor as `personal_agent` (which it is — the daemon
    /// owns the device's primary agent), and other participants as
    /// `unknown` until a richer source of truth is wired through. This is
    /// load-bearing for `agents_to_activate`, which only routes messages to
    /// participants whose stored actor_type is `personal_agent` or
    /// `role_agent`.
    pub async fn insert_session_from_backend(
        &mut self,
        session: &crate::backend::BackendSessionRow,
        participants: &[crate::backend::BackendParticipantRow],
    ) -> crate::error::Result<()> {
        let local_actor_id = self.actor_id.as_deref();
        let stored_participants: Vec<StoredParticipant> = participants
            .iter()
            .map(|p| {
                let actor_type = if local_actor_id.is_some_and(|a| a == p.actor_id) {
                    "personal_agent"
                } else {
                    "unknown"
                };
                StoredParticipant {
                    actor_id: p.actor_id.clone(),
                    actor_type: actor_type.to_string(),
                    display_name: String::new(),
                    joined_at: p.joined_at,
                }
            })
            .collect();

        let stored = StoredSession {
            session_id: session.id.clone(),
            team_id: session.team_id.clone(),
            title: session.title.clone(),
            created_by: session.created_by_actor_id.clone().unwrap_or_default(),
            created_at: session.created_at,
            summary: session.summary.clone(),
            idea_id: session.idea_id.clone().unwrap_or_default(),
            participants: stored_participants,
            primary_agent_id: session.primary_agent_id.clone().unwrap_or_default(),
        };

        self.sessions.upsert(stored);
        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!(
                "insert_session_from_backend: failed to save sessions: {}",
                e
            );
        }

        self.refresh_membership_subscriptions().await?;
        info!(
            session_id = %session.id,
            "inserted backend-sourced session into teamclu cache"
        );
        Ok(())
    }

    #[cfg(test)]
    pub async fn insert_session_from_backend_for_test(
        &mut self,
        session_id: &str,
        team_id: &str,
        primary_agent_id: Option<&str>,
        participants: &[(&str, &str)],
    ) -> crate::error::Result<()> {
        use crate::backend::{BackendParticipantRow, BackendSessionRow};
        let session = BackendSessionRow {
            id: session_id.into(),
            team_id: team_id.into(),
            created_by_actor_id: None,
            primary_agent_id: primary_agent_id.map(String::from),
            mode: "collab".into(),
            title: String::new(),
            summary: String::new(),
            idea_id: None,
            parent_session_id: None,
            thread_root_message_id: None,
            created_at: chrono::Utc::now(),
        };
        let now = chrono::Utc::now();
        let parts: Vec<BackendParticipantRow> = participants
            .iter()
            .map(|(actor, role)| BackendParticipantRow {
                session_id: session_id.into(),
                actor_id: (*actor).into(),
                role: Some((*role).into()),
                joined_at: now,
            })
            .collect();
        self.insert_session_from_backend(&session, &parts).await
    }

    async fn handle_create_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclu::CreateIdeaRequest,
    ) -> RpcResponse {
        let idea_id = Uuid::new_v4().to_string();
        // Prefer the request's `sender_actor_id` when supplied, otherwise
        // fall back to the RPC envelope's `requester_actor_id`.
        let created_by = if !r.sender_actor_id.is_empty() {
            r.sender_actor_id.clone()
        } else {
            req.requester_actor_id.clone()
        };
        let stored_item = StoredIdea {
            idea_id: idea_id.clone(),
            session_id: r.session_id.clone(),
            workspace_id: r.workspace_id.clone(),
            title: r.title.clone(),
            description: r.description.clone(),
            status: "open".to_string(),
            parent_id: r.parent_id.clone(),
            created_by,
            created_at: Utc::now(),
            archived: false,
        };

        let store_key = canonical_idea_store_key(&r.session_id);

        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                warn!("handle_create_idea: failed to load idea store: {}", e);
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        store.add_item(stored_item);

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_create_idea: failed to save idea store: {}", e);
        }

        let idea = store.find_item(&idea_id).map(|i| store.to_proto_idea(i));

        // Publish IdeaEvent
        if let Some(ref item) = idea {
            let event = teamclu::IdeaEvent {
                event: Some(teamclu::idea_event::Event::Created(item.clone())),
            };
            if !r.session_id.is_empty() {
                if let Err(e) = self
                    .live_publisher
                    .publish_idea_event("idea.created", &r.session_id, &item.created_by, &event)
                    .await
                {
                    warn!(
                        "handle_create_idea: failed to publish live idea event: {}",
                        e
                    );
                }
            }
        }

        info!(idea_id = %idea_id, session_id = %r.session_id, "idea created");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: idea.map(|t| teamclu::rpc_response::Result::Idea(t)),
        }
    }

    async fn handle_claim_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclu::ClaimIdeaRequest,
    ) -> RpcResponse {
        let store_key = canonical_idea_store_key(&r.session_id);
        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        let claim_id = Uuid::new_v4().to_string();
        let actor_id = if !r.sender_actor_id.is_empty() {
            r.sender_actor_id.clone()
        } else {
            req.requester_actor_id.clone()
        };
        let claim = StoredClaim {
            claim_id: claim_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            claimed_at: Utc::now(),
        };

        store.add_claim(claim);

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_claim_idea: failed to save idea store: {}", e);
        }

        let proto_claim = teamclu::Claim {
            claim_id: claim_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            claimed_at: Utc::now().timestamp(),
        };

        // Publish IdeaEvent
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Claimed(proto_claim.clone())),
        };
        if !r.session_id.is_empty() {
            if let Err(e) = self
                .live_publisher
                .publish_idea_event("idea.updated", &r.session_id, &proto_claim.actor_id, &event)
                .await
            {
                warn!(
                    "handle_claim_idea: failed to publish live claim event: {}",
                    e
                );
            }
        }

        info!(
            claim_id = %claim_id,
            idea_id = %r.idea_id,
            session_id = %r.session_id,
            "idea claimed"
        );

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: Some(teamclu::rpc_response::Result::Claim(proto_claim)),
        }
    }

    async fn handle_submit_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclu::SubmitIdeaRequest,
    ) -> RpcResponse {
        let store_key = canonical_idea_store_key(&r.session_id);
        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        let submission_id = Uuid::new_v4().to_string();
        let actor_id = if !r.sender_actor_id.is_empty() {
            r.sender_actor_id.clone()
        } else {
            req.requester_actor_id.clone()
        };
        let submission = StoredSubmission {
            submission_id: submission_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            content: r.content.clone(),
            submitted_at: Utc::now(),
        };

        store.add_submission(submission);

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_submit_idea: failed to save idea store: {}", e);
        }

        let proto_submission = teamclu::Submission {
            submission_id: submission_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            content: r.content.clone(),
            submitted_at: Utc::now().timestamp(),
        };

        // Publish IdeaEvent
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Submitted(
                proto_submission.clone(),
            )),
        };
        if !r.session_id.is_empty() {
            if let Err(e) = self
                .live_publisher
                .publish_idea_event(
                    "idea.updated",
                    &r.session_id,
                    &proto_submission.actor_id,
                    &event,
                )
                .await
            {
                warn!(
                    "handle_submit_idea: failed to publish live submission event: {}",
                    e
                );
            }
        }

        info!(
            submission_id = %submission_id,
            idea_id = %r.idea_id,
            session_id = %r.session_id,
            "idea submitted"
        );

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: Some(teamclu::rpc_response::Result::Submission(proto_submission)),
        }
    }

    async fn handle_update_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclu::UpdateIdeaRequest,
    ) -> RpcResponse {
        let store_key = if r.session_id.is_empty() {
            "global"
        } else {
            &r.session_id
        };

        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        };

        match store.find_item_mut(&r.idea_id) {
            Some(item) => {
                if !r.title.is_empty() {
                    item.title = r.title.clone();
                }
                if !r.description.is_empty() {
                    item.description = r.description.clone();
                }
                // Update status if non-zero (unknown is 0)
                if r.status != 0 {
                    item.status = idea_status_to_string(r.status);
                }
                if let Some(v) = r.archived {
                    item.archived = v;
                }
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("idea {} not found", r.idea_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    result: None,
                };
            }
        }

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_update_idea: failed to save idea store: {}", e);
        }

        let idea = store.find_item(&r.idea_id).map(|i| store.to_proto_idea(i));

        // Publish IdeaEvent
        if let Some(ref item) = idea {
            let event = teamclu::IdeaEvent {
                event: Some(teamclu::idea_event::Event::Updated(item.clone())),
            };
            if !r.session_id.is_empty() {
                if let Err(e) = self
                    .live_publisher
                    .publish_idea_event(
                        "idea.updated",
                        &r.session_id,
                        &req.requester_actor_id,
                        &event,
                    )
                    .await
                {
                    warn!(
                        "handle_update_idea: failed to publish live update event: {}",
                        e
                    );
                }
            }
        }

        info!(
            idea_id = %r.idea_id,
            session_id = %r.session_id,
            archived = ?r.archived,
            "idea updated"
        );

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: idea.map(|t| teamclu::rpc_response::Result::Idea(t)),
        }
    }

    // --- Public helpers ---

    /// Persist an incoming message for a session.
    pub async fn persist_message(
        &self,
        session_id: &str,
        message: &teamclu::Message,
    ) -> crate::error::Result<()> {
        let stored = StoredMessage {
            message_id: message.message_id.clone(),
            session_id: message.session_id.clone(),
            sender_actor_id: message.sender_actor_id.clone(),
            kind: message_kind_to_string(message.kind),
            content: message.content.clone(),
            created_at: chrono::DateTime::from_timestamp(message.created_at, 0)
                .unwrap_or_else(Utc::now),
            reply_to_message_id: message.reply_to_message_id.clone(),
            mentions: message.mentions.clone(),
            model: message.model.clone(),
            metadata_json: message.metadata_json.clone(),
            turn_id: message.turn_id.clone(),
        };

        let mut store = MessageStore::load(&self.config_dir, session_id)?;
        store.append(stored);
        store.save(&self.config_dir, session_id)?;
        Ok(())
    }

    /// Returns the agent actor_ids that should receive this message.
    ///
    /// If there's only one agent in the session, all messages are relevant.
    /// Otherwise, only agents that are explicitly mentioned.
    #[allow(dead_code)]
    pub fn agents_to_activate(&self, session_id: &str, message: &teamclu::Message) -> Vec<String> {
        let session = match self.sessions.find_by_id(session_id) {
            Some(s) => s,
            None => return vec![],
        };

        let agents: Vec<String> = session
            .participants
            .iter()
            .filter(|p| p.actor_type == "personal_agent" || p.actor_type == "role_agent")
            .map(|p| p.actor_id.clone())
            .collect();

        if agents.len() == 1 {
            // Only one agent — all messages activate it
            return agents;
        }

        // Multiple agents — only activate those mentioned
        agents
            .into_iter()
            .filter(|actor_id| message.mentions.contains(actor_id))
            .collect()
    }

    /// Returns the agent actor_ids that should be activated for a idea event.
    ///
    /// - Claimed → activate the claiming agent
    /// - Updated → activate all agents that claimed the idea
    /// - Submitted → activate other claimants (not the submitter)
    pub fn agents_to_activate_for_idea(
        &self,
        session_id: &str,
        event: &teamclu::IdeaEvent,
    ) -> Vec<String> {
        match &event.event {
            Some(teamclu::idea_event::Event::Claimed(claim)) => {
                vec![claim.actor_id.clone()]
            }
            Some(teamclu::idea_event::Event::Updated(idea)) => {
                // Activate all agents that claimed this idea
                match IdeaStore::load(&self.config_dir, canonical_idea_store_key(session_id)) {
                    Ok(store) => store
                        .claims_for_idea(&idea.idea_id)
                        .into_iter()
                        .map(|c| c.actor_id.clone())
                        .collect(),
                    Err(_) => vec![],
                }
            }
            Some(teamclu::idea_event::Event::Submitted(submission)) => {
                // Activate other claimants (not the submitter)
                match IdeaStore::load(&self.config_dir, canonical_idea_store_key(session_id)) {
                    Ok(store) => store
                        .claims_for_idea(&submission.idea_id)
                        .into_iter()
                        .filter(|c| c.actor_id != submission.actor_id)
                        .map(|c| c.actor_id.clone())
                        .collect(),
                    Err(_) => vec![],
                }
            }
            Some(teamclu::idea_event::Event::Created(_)) | None => vec![],
        }
    }

    /// Get session_ids where this agent participates.
    #[allow(dead_code)]
    pub fn sessions_for_agent(&self, agent_actor_id: &str) -> Vec<String> {
        self.sessions
            .sessions
            .iter()
            .filter(|s| s.participants.iter().any(|p| p.actor_id == agent_actor_id))
            .map(|s| s.session_id.clone())
            .collect()
    }

    /// Fan-out wrapper around `LivePublisher::publish_acp_event` for a single
    /// session. Mirrors the `publish_agent_message` indirection so server.rs
    /// can stay decoupled from the LivePublisher type.
    pub async fn publish_agent_acp_event(
        &self,
        session_id: &str,
        agent_actor_id: &str,
        envelope: &crate::proto::amux::Envelope,
    ) {
        let _ = self
            .live_publisher
            .publish_acp_event(session_id, agent_actor_id, envelope)
            .await;
    }

    /// Announce an adopted session title on the session's live topic so
    /// clients update their lists in place.
    pub async fn publish_session_title(&self, session_id: &str, actor_id: &str, title: &str) {
        let _ = self
            .live_publisher
            .publish_session_title(session_id, actor_id, title)
            .await;
    }

    /// Publish an agent's output as a session message.
    ///
    /// `model` is the model id the agent was running on when it produced this
    /// reply (looked up from `RuntimeManager.current_model` by the caller).
    /// Pass an empty string for legacy / unknown.
    #[allow(dead_code)]
    pub async fn publish_agent_message(
        &self,
        session_id: &str,
        agent_actor_id: &str,
        content: &str,
        model: &str,
    ) {
        let msg = teamclu::Message {
            message_id: Uuid::new_v4().to_string()[..8].to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: agent_actor_id.to_string(),
            kind: teamclu::MessageKind::Text as i32,
            content: content.to_string(),
            created_at: Utc::now().timestamp(),
            model: model.to_string(),
            ..Default::default()
        };
        let envelope = teamclu::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec![],
        };
        let _ = self
            .live_publisher
            .publish_message(session_id, agent_actor_id, &envelope)
            .await;
    }

    /// Emit one logical agent message: append to local TOML, publish to
    /// session/live as `message.created`, and (if `persist_backend`) write
    /// to backend `messages`.
    ///
    /// Returns `true` when a requested cloud persist succeeded (or was not
    /// requested). Returns `false` when `persist_backend` was requested but
    /// `insert_message` failed — callers must not advance catchup cursors.
    #[allow(clippy::too_many_arguments)]
    pub async fn emit_agent_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        kind: crate::proto::teamclu::MessageKind,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        reply_to_message_id: &str,
        sequence: u64,
        persist_backend: bool,
        backend: Option<&std::sync::Arc<dyn Backend>>,
    ) -> bool {
        // An agent reply addresses no one, and it is written by the same daemon
        // that would answer a mention — so there is nothing to claim either.
        self.emit_session_message(
            SessionMessageWrite {
                session_id,
                sender_actor_id,
                kind,
                content,
                metadata_json,
                model,
                turn_id,
                reply_to_message_id,
                sequence,
                claim_before_publish: false,
                persist_local: true,
                persist_backend,
            },
            backend,
        )
        .await
    }

    /// Write one message into a session: claim, broadcast, persist, insert —
    /// in that order, once.
    ///
    /// The #933 write service. Everything that puts a message into a session
    /// from the daemon side goes through here, so "what a message looks like"
    /// is decided in one place instead of being re-derived per caller. Before
    /// this, `emit_agent_message` and cron's `persist_cron_user_prompt` were
    /// two hand-rolled copies that had already drifted apart on ordering.
    ///
    /// `claim_before_publish` exists because the daemon subscribes to its own
    /// sessions' live topics: a message that names this daemon's agent comes
    /// straight back and `route_session_message` would start a second turn for
    /// it. Claiming the id in the shared `MessageDedup` *before* publishing
    /// closes that gate first. An agent reply does not need it (the sender is
    /// this daemon, which `route_session_message` skips outright); a prompt
    /// written on the agent's behalf does.
    pub async fn emit_session_message(
        &self,
        write: SessionMessageWrite<'_>,
        backend: Option<&std::sync::Arc<dyn Backend>>,
    ) -> bool {
        let SessionMessageWrite {
            session_id,
            sender_actor_id,
            kind,
            content,
            metadata_json,
            model,
            turn_id,
            reply_to_message_id,
            sequence,
            claim_before_publish,
            persist_local,
            persist_backend,
        } = write;
        let message_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        if claim_before_publish {
            self.recent_events.claim_message(session_id, &message_id);
        }

        let proto_msg = crate::proto::teamclu::Message {
            message_id: message_id.clone(),
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.to_string(),
            kind: kind as i32,
            content: content.to_string(),
            created_at: now.timestamp(),
            model: model.to_string(),
            metadata_json: metadata_json.to_string(),
            turn_id: turn_id.to_string(),
            reply_to_message_id: reply_to_message_id.to_string(),
            ..Default::default()
        };

        // 1. session/{sid}/live as `message.created` FIRST. File IO (the TOML
        //    write below) must not delay peers/clients seeing the finalized
        //    reply — a slow disk / AV scan stalling persist would otherwise
        //    hold up the live publish. Both are independent and best-effort
        //    (each only warns on failure; neither feeds the other).
        //    Multi-daemon sessions (peer daemon B's runtimes need to see
        //    daemon A's agent reply as silent context) require AgentReply
        //    to land on the live channel. iOS no longer renders these as
        //    chat bubbles — the kind filter in handleIncomingChatMessage
        //    drops agent_reply and lets handleAcpEvent's isComplete=true
        //    output own that bubble.
        // Mentions ride from the metadata, so a caller that means them (cron
        // writing a prompt on the agent's behalf) gets them and one that does
        // not (an agent reply) sends an empty list without special-casing.
        let envelope = crate::proto::teamclu::SessionMessageEnvelope {
            message: Some(proto_msg.clone()),
            mention_actor_ids: crate::daemon::session_events::parse_mention_actor_ids(
                metadata_json,
            ),
        };
        if let Err(e) = self
            .live_publisher
            .publish_message(session_id, sender_actor_id, &envelope)
            .await
        {
            warn!(?e, session_id, "publish_message failed");
        }

        // 2. Local TOML (durable history; not on the live path).
        if persist_local {
            if let Err(e) = self.persist_message(session_id, &proto_msg).await {
                warn!(?e, session_id, "persist_message failed");
            }
        }

        // 3. Backend (turn-final AgentReply only — see TurnAggregator::cloud_persistent).
        // Await the insert: catchup after restart reads cloud messages, so a
        // fire-and-forget write can race with daemon shutdown and leave an
        // @mention unanswered (re-prompt after interrupt).
        if persist_backend {
            let Some(sb) = backend else {
                warn!(session_id, "persist_backend requested but no backend");
                return false;
            };
            let team_id = self.team_id.clone();
            // message_kind_to_string is the pub(crate) fn defined later in this file.
            let kind_str = message_kind_to_string(kind as i32);
            if let Err(e) = sb
                .insert_message(
                    &message_id,
                    &team_id,
                    session_id,
                    sender_actor_id,
                    &kind_str,
                    content,
                    metadata_json,
                    model,
                    turn_id,
                    reply_to_message_id,
                    sequence,
                )
                .await
            {
                warn!(?e, "backend insert_message failed");
                return false;
            }
        }
        true
    }
}

/// One message on its way into a session. A struct rather than a dozen
/// positional arguments because the two flags at the end decide correctness,
/// not formatting, and `true, true, false` at a call site says nothing.
pub struct SessionMessageWrite<'a> {
    pub session_id: &'a str,
    pub sender_actor_id: &'a str,
    pub kind: crate::proto::teamclu::MessageKind,
    pub content: &'a str,
    pub metadata_json: &'a str,
    pub model: &'a str,
    pub turn_id: &'a str,
    pub reply_to_message_id: &'a str,
    pub sequence: u64,
    /// Close the loopback gate before broadcasting. See `emit_session_message`.
    pub claim_before_publish: bool,
    /// Write to the session's local TOML history.
    pub persist_local: bool,
    /// Insert into the cloud `messages` table.
    pub persist_backend: bool,
}

impl SessionManager {
    #[allow(dead_code)]
    pub async fn ensure_session_subscription(
        &mut self,
        _session_id: &str,
    ) -> crate::error::Result<()> {
        self.refresh_membership_subscriptions().await
    }

    /// Subscribe to `session/{sid}/live` when attaching a runtime. Unlike
    /// `refresh_membership_subscriptions`, this does not depend on the local
    /// participant cache being complete — a race where the backend fetch omits
    /// the daemon actor must not leave us deaf to inbound @-mentions.
    pub async fn ensure_session_live_subscription(
        &mut self,
        session_id: &str,
    ) -> crate::error::Result<()> {
        if session_id.is_empty() {
            return Ok(());
        }
        if self.subscribed_live_sessions.contains(session_id) {
            return Ok(());
        }
        self.subscribe_session_live(session_id).await?;
        self.subscribed_live_sessions.insert(session_id.to_string());
        Ok(())
    }

    pub async fn refresh_membership_subscriptions(&mut self) -> crate::error::Result<()> {
        self.apply_membership_sessions(self.membership_session_ids())
            .await
    }

    pub async fn apply_membership_sessions(
        &mut self,
        session_ids: Vec<String>,
    ) -> crate::error::Result<()> {
        let desired: BTreeSet<String> = session_ids
            .into_iter()
            .filter(|session_id| !session_id.is_empty())
            .collect();

        let to_subscribe: Vec<String> = desired
            .difference(&self.subscribed_live_sessions)
            .cloned()
            .collect();
        let to_unsubscribe: Vec<String> = self
            .subscribed_live_sessions
            .difference(&desired)
            .cloned()
            .collect();

        for session_id in &to_subscribe {
            self.subscribe_session_live(session_id).await?;
            self.request_recent_session_events(session_id).await?;
        }

        for session_id in &to_unsubscribe {
            self.unsubscribe_session_live(session_id).await?;
        }

        self.subscribed_live_sessions = desired;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn subscribed_live_sessions(&self) -> Vec<String> {
        self.subscribed_live_sessions.iter().cloned().collect()
    }

    pub fn should_process_message(&mut self, session_id: &str, message_id: &str) -> bool {
        self.record_recent_event(format!("message:{session_id}:{message_id}"))
    }

    pub fn should_process_idea_event(
        &mut self,
        session_id: &str,
        event: &teamclu::IdeaEvent,
    ) -> bool {
        let key = match &event.event {
            Some(teamclu::idea_event::Event::Created(idea)) => {
                format!("idea-created:{session_id}:{}", idea.idea_id)
            }
            Some(teamclu::idea_event::Event::Updated(idea)) => {
                format!("idea-updated:{session_id}:{}", idea.idea_id)
            }
            Some(teamclu::idea_event::Event::Claimed(claim)) => {
                format!("claim:{session_id}:{}", claim.claim_id)
            }
            Some(teamclu::idea_event::Event::Submitted(submission)) => {
                format!("submission:{session_id}:{}", submission.submission_id)
            }
            None => return true,
        };
        self.record_recent_event(key)
    }

    // --- Private helpers ---

    async fn subscribe_session_live(&self, session_id: &str) -> crate::error::Result<()> {
        #[cfg(test)]
        if self.skip_live_subscription_io {
            return Ok(());
        }
        let topic = self.live_session_topic(session_id);
        self.client
            .subscribe(&topic, DeliveryGuarantee::AtLeastOnce)
            .await?;
        info!(session_id, topic = %topic, "subscribed to session live");
        Ok(())
    }

    async fn unsubscribe_session_live(&self, session_id: &str) -> crate::error::Result<()> {
        #[cfg(test)]
        if self.skip_live_subscription_io {
            return Ok(());
        }
        let topic = self.live_session_topic(session_id);
        self.client.unsubscribe(&topic).await?;
        // We've seen "second user message never lands on daemon" reports
        // that look like the subscription went away between turns —
        // surface every unsubscribe so the next repro shows whether it
        // happened, and which membership-refresh path triggered it.
        warn!(session_id, topic = %topic, "unsubscribed from session live");
        Ok(())
    }

    fn base_subscription_topics(&self) -> Vec<String> {
        vec![
            self.topics.actor_rpc_req(),
            self.topics.actor_notify(),
            self.topics.actor_rpc_res(),
        ]
    }

    fn live_session_topic(&self, session_id: &str) -> String {
        self.topics.session_live(session_id)
    }

    pub fn membership_session_ids(&self) -> Vec<String> {
        let local_actor_id = self.actor_id.as_deref();
        self.sessions
            .sessions
            .iter()
            .filter(|session| {
                local_actor_id.is_some_and(|actor_id| {
                    session
                        .participants
                        .iter()
                        .any(|participant| participant.actor_id == actor_id)
                })
            })
            .map(|session| session.session_id.clone())
            .collect()
    }

    async fn request_recent_session_events(&self, _session_id: &str) -> crate::error::Result<()> {
        Ok(())
    }

    fn record_recent_event(&mut self, key: String) -> bool {
        self.recent_events.claim_key(key)
    }

    fn membership_refresh_targets(
        &self,
        _session_id: &str,
        requester_actor_id: Option<&str>,
    ) -> Vec<String> {
        let mut targets = Vec::new();

        if let Some(requester_actor_id) = requester_actor_id {
            if !requester_actor_id.is_empty() && requester_actor_id != self.config_actor_id {
                targets.push(requester_actor_id.to_string());
            }
        }

        // The current request shapes only identify actors being invited/removed,
        // not the target actor for those actors, so direct invitee targeting
        // is not possible here without additional membership/actor mapping.
        targets
    }
}

// --- Helpers ---

fn actor_type_to_string(actor_type: i32) -> String {
    match actor_type {
        x if x == teamclu::ActorType::Human as i32 => "human",
        x if x == teamclu::ActorType::PersonalAgent as i32 => "personal_agent",
        x if x == teamclu::ActorType::RoleAgent as i32 => "role_agent",
        _ => "unknown",
    }
    .to_string()
}

fn participant_is_agent(actor_type: i32) -> bool {
    actor_type == teamclu::ActorType::PersonalAgent as i32
        || actor_type == teamclu::ActorType::RoleAgent as i32
}

fn stored_participant_to_proto(participant: &StoredParticipant) -> teamclu::Participant {
    teamclu::Participant {
        actor_id: participant.actor_id.clone(),
        actor_type: match participant.actor_type.as_str() {
            "human" => teamclu::ActorType::Human as i32,
            "personal_agent" => teamclu::ActorType::PersonalAgent as i32,
            "role_agent" => teamclu::ActorType::RoleAgent as i32,
            _ => teamclu::ActorType::Unknown as i32,
        },
        display_name: participant.display_name.clone(),
        joined_at: participant.joined_at.timestamp(),
    }
}

fn canonical_idea_store_key(session_id: &str) -> &str {
    if session_id.is_empty() {
        "global"
    } else {
        session_id
    }
}

pub(crate) fn message_kind_to_string(kind: i32) -> String {
    match teamclu::MessageKind::try_from(kind).unwrap_or(teamclu::MessageKind::Unknown) {
        teamclu::MessageKind::Text => "text",
        teamclu::MessageKind::System => "system",
        teamclu::MessageKind::WorkEvent => "work_event",
        teamclu::MessageKind::AgentThinking => "agent_thinking",
        teamclu::MessageKind::AgentToolCall => "agent_tool_call",
        teamclu::MessageKind::AgentToolResult => "agent_tool_result",
        teamclu::MessageKind::AgentReply => "agent_reply",
        teamclu::MessageKind::Unknown => "unknown",
    }
    .to_string()
}

fn idea_status_to_string(status: i32) -> String {
    match status {
        x if x == teamclu::IdeaStatus::Open as i32 => "open",
        x if x == teamclu::IdeaStatus::InProgress as i32 => "in_progress",
        x if x == teamclu::IdeaStatus::Done as i32 => "done",
        _ => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::teamclu::{IdeaStore, StoredClaim, StoredParticipant, StoredSession};
    use chrono::Utc;
    use std::path::Path;
    use tempfile::TempDir;

    fn dummy_session_manager(config_dir: &Path) -> SessionManager {
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let client: Arc<dyn MessagePublisher> = Arc::new(client);
        let mut manager =
            SessionManager::new(client, "team1", "dev-a", None, config_dir.to_path_buf()).unwrap();
        manager.skip_live_subscription_io = true;
        manager
    }

    fn make_session(id: &str) -> StoredSession {
        StoredSession {
            session_id: id.to_string(),
            team_id: "team1".to_string(),
            title: format!("Session {}", id),
            created_by: "user1".to_string(),
            created_at: Utc::now(),
            summary: String::new(),
            participants: vec![],
            primary_agent_id: String::new(),
            idea_id: String::new(),
        }
    }

    fn make_agent_participant(actor_id: &str) -> StoredParticipant {
        StoredParticipant {
            actor_id: actor_id.to_string(),
            actor_type: "personal_agent".to_string(),
            display_name: actor_id.to_string(),
            joined_at: Utc::now(),
        }
    }

    fn make_human_participant(actor_id: &str) -> StoredParticipant {
        StoredParticipant {
            actor_id: actor_id.to_string(),
            actor_type: "human".to_string(),
            display_name: actor_id.to_string(),
            joined_at: Utc::now(),
        }
    }

    fn make_message(session_id: &str, mentions: Vec<String>) -> teamclu::Message {
        teamclu::Message {
            message_id: "msg1".to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "human1".to_string(),
            kind: teamclu::MessageKind::Text as i32,
            content: "hello".to_string(),
            created_at: Utc::now().timestamp(),
            mentions,
            ..Default::default()
        }
    }

    // --- agents_to_activate tests ---

    #[test]
    fn test_agents_to_activate_no_session() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());
        let msg = make_message("nonexistent", vec![]);
        let result = sm.agents_to_activate("nonexistent", &msg);
        assert!(result.is_empty());
    }

    #[test]
    fn test_agents_to_activate_session_no_agents() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_human_participant("human1"));
        sm.sessions.upsert(session);

        let msg = make_message("s1", vec![]);
        let result = sm.agents_to_activate("s1", &msg);
        assert!(result.is_empty());
    }

    #[test]
    fn test_agents_to_activate_sole_agent_gets_all_messages() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_human_participant("human1"));
        session.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(session);

        // No mentions — sole agent still receives it
        let msg = make_message("s1", vec![]);
        let result = sm.agents_to_activate("s1", &msg);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_agents_to_activate_two_agents_mentioned_one() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_agent_participant("agent1"));
        session.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(session);

        let msg = make_message("s1", vec!["agent1".to_string()]);
        let result = sm.agents_to_activate("s1", &msg);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_agents_to_activate_two_agents_no_mention_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_agent_participant("agent1"));
        session.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(session);

        let msg = make_message("s1", vec![]);
        let result = sm.agents_to_activate("s1", &msg);
        assert!(result.is_empty());
    }

    #[test]
    fn test_agents_to_activate_sender_is_agent_still_returned() {
        // Filtering out the sender happens in server.rs, not here.
        // The method should still return the agent even if they sent the message.
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(session);

        let mut msg = make_message("s1", vec![]);
        msg.sender_actor_id = "agent1".to_string();

        let result = sm.agents_to_activate("s1", &msg);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_membership_refresh_targets_only_include_requester() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let targets = sm.membership_refresh_targets("s1", Some("dev-requester"));
        assert_eq!(targets, vec!["dev-requester".to_string()]);
    }

    #[test]
    fn test_membership_refresh_targets_skip_local_requester() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let targets = sm.membership_refresh_targets("s1", Some("dev-a"));
        assert!(targets.is_empty());
    }

    fn make_test_session_manager_with_actor(actor_id: &str) -> (TempDir, SessionManager) {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let client: Arc<dyn MessagePublisher> = Arc::new(client);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some(actor_id.to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;
        (tmp, sm)
    }

    fn test_message(sender_actor_id: &str, session_id: &str, content: &str) -> teamclu::Message {
        teamclu::Message {
            message_id: "msg-test".to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.to_string(),
            kind: teamclu::MessageKind::Text as i32,
            content: content.to_string(),
            created_at: Utc::now().timestamp(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn test_ensure_session_live_subscription_subscribes_without_membership_refresh() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());
        sm.skip_live_subscription_io = true;

        sm.ensure_session_live_subscription("sess-new")
            .await
            .unwrap();

        assert!(sm
            .subscribed_live_sessions()
            .contains(&"sess-new".to_string()));
    }

    #[tokio::test]
    async fn test_insert_session_from_backend_subscribes_when_daemon_is_participant() {
        let (_tmp, mut sm) = make_test_session_manager_with_actor("daemon-actor-1");

        sm.insert_session_from_backend_for_test(
            "sess-1",
            "team-1",
            Some("daemon-actor-1"),
            &[("user-1", "member"), ("daemon-actor-1", "member")],
        )
        .await
        .unwrap();

        let subs = sm.subscribed_live_sessions();
        assert!(
            subs.contains(&"sess-1".to_string()),
            "expected sess-1 to be subscribed; got {subs:?}"
        );

        let msg = test_message("user-1", "sess-1", "hello");
        let activated = sm.agents_to_activate("sess-1", &msg);
        assert_eq!(activated, vec!["daemon-actor-1".to_string()]);
    }

    #[tokio::test]
    async fn test_apply_membership_sessions_adds_and_removes_live_subscriptions() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        sm.apply_membership_sessions(vec!["sess-1".to_string(), "sess-2".to_string()])
            .await
            .unwrap();
        assert_eq!(
            sm.subscribed_live_sessions(),
            vec!["sess-1".to_string(), "sess-2".to_string()]
        );

        sm.apply_membership_sessions(vec!["sess-2".to_string()])
            .await
            .unwrap();
        assert_eq!(sm.subscribed_live_sessions(), vec!["sess-2".to_string()]);
    }

    #[tokio::test]
    async fn test_refresh_membership_subscriptions_uses_local_actor_truth() {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let client: Arc<dyn MessagePublisher> = Arc::new(client);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some("member-a".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;

        let mut joined = make_session("joined");
        joined.participants.push(make_human_participant("member-a"));

        let mut unrelated = make_session("unrelated");
        unrelated
            .participants
            .push(make_human_participant("someone-else"));

        sm.sessions.upsert(joined);
        sm.sessions.upsert(unrelated);

        sm.refresh_membership_subscriptions().await.unwrap();

        assert_eq!(sm.subscribed_live_sessions(), vec!["joined".to_string()]);
    }

    #[tokio::test]
    async fn test_subscribe_all_rebuilds_live_set_from_membership_truth() {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let client: Arc<dyn MessagePublisher> = Arc::new(client);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some("member-a".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;

        let mut joined = make_session("joined");
        joined.participants.push(make_human_participant("member-a"));

        sm.sessions.upsert(joined);

        sm.subscribe_all().await.unwrap();

        assert_eq!(sm.subscribed_live_sessions(), vec!["joined".to_string()]);
    }

    #[tokio::test]
    async fn test_subscribe_all_reconciles_live_set_after_membership_changes() {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let client: Arc<dyn MessagePublisher> = Arc::new(client);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some("member-a".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;

        let mut joined = make_session("joined");
        joined.participants.push(make_human_participant("member-a"));

        sm.sessions.upsert(joined);
        sm.subscribe_all().await.unwrap();
        assert_eq!(sm.subscribed_live_sessions(), vec!["joined".to_string()]);

        let mut unrelated = make_session("replacement");
        sm.sessions.sessions.clear();
        sm.sessions.upsert(unrelated);

        sm.subscribe_all().await.unwrap();

        assert!(sm.subscribed_live_sessions().is_empty());
    }

    #[test]
    fn test_base_subscription_topics_exclude_retained_session_state_topics() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());
        sm.actor_id = Some("member-a".to_string());

        let topics = sm.base_subscription_topics();

        assert!(topics.contains(&"amux/team1/dev-a/rpc/req".to_string()));
        assert!(topics.contains(&"amux/team1/dev-a/rpc/res".to_string()));
        assert!(topics.contains(&"amux/team1/dev-a/notify".to_string()));
        assert!(!topics.contains(&"amux/team1/sessions".to_string()));
        assert!(!topics
            .iter()
            .any(|topic| topic.contains("/actor/member-a/session/")));
    }

    #[test]
    fn test_session_live_topic_is_distinct_from_legacy_rollout_topics() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        let live = sm.live_session_topic("s1");

        assert_eq!(live, "amux/team1/session/s1/live");
    }

    #[test]
    fn test_recent_event_dedupe_uses_stable_ids() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        assert!(sm.should_process_message("s1", "m1"));
        assert!(!sm.should_process_message("s1", "m1"));

        let created = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Created(teamclu::Idea {
                idea_id: "t1".to_string(),
                session_id: "s1".to_string(),
                ..Default::default()
            })),
        };
        let updated = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Updated(teamclu::Idea {
                idea_id: "t1".to_string(),
                session_id: "s1".to_string(),
                ..Default::default()
            })),
        };
        assert!(sm.should_process_idea_event("s1", &created));
        assert!(!sm.should_process_idea_event("s1", &created));
        assert!(sm.should_process_idea_event("s1", &updated));
        assert!(!sm.should_process_idea_event("s1", &updated));
    }

    #[test]
    fn test_canonical_idea_store_key_maps_empty_to_global() {
        assert_eq!(canonical_idea_store_key(""), "global");
        assert_eq!(canonical_idea_store_key("s1"), "s1");
    }

    // --- agents_to_activate_for_idea tests ---

    #[test]
    fn test_idea_claimed_returns_claimant() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        let claim = teamclu::Claim {
            claim_id: "c1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(),
            claimed_at: Utc::now().timestamp(),
        };
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Claimed(claim)),
        };

        let result = sm.agents_to_activate_for_idea("s1", &event);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_idea_updated_returns_all_claimants() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        // Set up IdeaStore on disk with two claims for "w1"
        let mut store = IdeaStore::default();
        store.claims.push(StoredClaim {
            claim_id: "c1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(),
            claimed_at: Utc::now(),
        });
        store.claims.push(StoredClaim {
            claim_id: "c2".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent2".to_string(),
            claimed_at: Utc::now(),
        });
        store.save(tmp.path(), "s1").unwrap();

        let idea = teamclu::Idea {
            idea_id: "w1".to_string(),
            session_id: "s1".to_string(),
            ..Default::default()
        };
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Updated(idea)),
        };

        let mut result = sm.agents_to_activate_for_idea("s1", &event);
        result.sort();
        assert_eq!(result, vec!["agent1".to_string(), "agent2".to_string()]);
    }

    #[test]
    fn test_idea_submitted_returns_other_claimants() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        // agent1 and agent2 claimed w1; agent1 submits — only agent2 should be notified
        let mut store = IdeaStore::default();
        store.claims.push(StoredClaim {
            claim_id: "c1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(),
            claimed_at: Utc::now(),
        });
        store.claims.push(StoredClaim {
            claim_id: "c2".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent2".to_string(),
            claimed_at: Utc::now(),
        });
        store.save(tmp.path(), "s1").unwrap();

        let submission = teamclu::Submission {
            submission_id: "sub1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(), // submitter
            content: "done".to_string(),
            submitted_at: Utc::now().timestamp(),
        };
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Submitted(submission)),
        };

        let result = sm.agents_to_activate_for_idea("s1", &event);
        assert_eq!(result, vec!["agent2".to_string()]);
    }

    #[test]
    fn test_idea_created_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        let idea = teamclu::Idea {
            idea_id: "w1".to_string(),
            session_id: "s1".to_string(),
            ..Default::default()
        };
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Created(idea)),
        };

        let result = sm.agents_to_activate_for_idea("s1", &event);
        assert!(result.is_empty());
    }

    // --- sessions_for_agent tests ---

    #[test]
    fn test_sessions_for_agent_in_two_sessions() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut s1 = make_session("s1");
        s1.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(s1);

        let mut s2 = make_session("s2");
        s2.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(s2);

        // s3 does not have agent1
        let mut s3 = make_session("s3");
        s3.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(s3);

        let mut result = sm.sessions_for_agent("agent1");
        result.sort();
        assert_eq!(result, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn test_sessions_for_agent_not_in_any_session() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut s1 = make_session("s1");
        s1.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(s1);

        let result = sm.sessions_for_agent("agent1");
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn emit_agent_message_persists_reply_to_message_id() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        sm.emit_agent_message(
            "s-quote",
            "agent-a",
            teamclu::MessageKind::AgentReply,
            "final answer",
            "{}",
            "model-x",
            "turn-quote",
            "user-parent-1",
            7,
            false,
            None,
        )
        .await;

        let store = MessageStore::load(tmp.path(), "s-quote").unwrap();
        assert_eq!(store.messages.len(), 1);
        let msg = &store.messages[0];
        assert_eq!(msg.reply_to_message_id, "user-parent-1");
        assert_eq!(msg.turn_id, "turn-quote");
        assert_eq!(msg.content, "final answer");
        let proto = MessageStore::to_proto(msg);
        assert_eq!(proto.reply_to_message_id, "user-parent-1");
    }

    #[test]
    fn message_dedup_is_shared_between_clones() {
        // The gateway holds a clone and claims ids on it; the daemon loop must
        // see those claims, or it runs the turn a second time off its own
        // loopback.
        let a = MessageDedup::new();
        let b = a.clone();
        assert!(a.claim_message("s1", "m1"));
        assert!(!b.claim_message("s1", "m1"));
        assert!(b.claim_message("s1", "m2"));
    }

    #[test]
    fn message_dedup_lets_an_empty_id_through() {
        // No id means nothing to dedup on; refusing would drop the message.
        let d = MessageDedup::new();
        assert!(d.claim_message("s1", ""));
        assert!(d.claim_message("s1", ""));
    }
}
