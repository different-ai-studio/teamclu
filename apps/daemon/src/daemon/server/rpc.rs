//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

/// The slugs the inventory's team branch speaks for: rows the registry reports
/// as installed for this Agent.
///
/// This set — not the presence of an `origin.json` — is what makes a directory
/// under `~/.agents/skills` somebody else's to report. An origin only says the
/// directory arrived as a package; it says nothing about whether any row will
/// actually claim it, and two ordinary flows leave packs that none does:
///
/// - a ClawHub install (`clawhub_install` stamps its own v1 payload, registry
///   URL, no team) — the team registry has never heard of it;
/// - a skill shared from this machine, whose install got recorded against the
///   member actor rather than the Agent, so the Agent's own row is missing.
///
/// Judging by the origin dropped both out of the inventory entirely: skipped by
/// the personal branch, never emitted by the team branch, invisible in the
/// skills column while the runtime went on loading them off disk. Judging by
/// what was actually emitted cannot do that — an unclaimed pack is reported as
/// the Agent's own, which is the honest reading and, more to the point, is
/// visible.
fn claimed_slugs(rows: &[crate::backend::TeamSkillRow]) -> std::collections::BTreeSet<String> {
    rows.iter()
        .filter(|row| row.installed)
        .map(|row| row.slug.clone())
        .collect()
}

async fn skill_inventory(
    backend: &dyn crate::backend::Backend,
    team_id: &str,
) -> Result<Vec<crate::proto::teamclu::AgentSkillInventoryItem>, String> {
    use crate::proto::teamclu::AgentSkillInventoryItem;
    let desired = backend
        .team_skills(team_id)
        .await
        .map_err(|e| e.to_string())?;
    let root = crate::runtime::team_skills::team_cloud_skills_dir(team_id);
    let mut items = Vec::new();
    let claimed = claimed_slugs(&desired);
    for row in desired.into_iter().filter(|row| row.installed) {
        let origin = teamclu_skillpack::read_origin(&root.join(&row.slug));
        let actual_version = origin
            .as_ref()
            .and_then(|value| value.installed_version.parse::<i64>().ok())
            .unwrap_or_default();
        // `desired_version` is what the reconciler will actually put on disk.
        // Using `installed_version` here instead — the agent's last *report* —
        // called a pending update "installed" until the next writeback landed,
        // and called a successful install "drift" whenever a writeback failed.
        let wanted = crate::runtime::team_skills::desired_version(&row);
        let installed = actual_version == wanted;
        items.push(AgentSkillInventoryItem {
            id: row.slug.clone(),
            name: row.slug.clone(),
            source: "team".into(),
            version: actual_version,
            team_item: true,
            read_only: false,
            health: if installed { "installed" } else { "drift" }.into(),
            error_code: if installed {
                String::new()
            } else {
                "team_skill_missing_or_wrong_version".into()
            },
        });
    }

    if let Some(home) = dirs::home_dir() {
        let personal_root = home.join(".agents/skills");
        if let Ok(entries) = std::fs::read_dir(personal_root) {
            for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
                let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                // Already spoken for by the team branch above; reporting it twice
                // would put the same slug in the list under two ids.
                if claimed.contains(&slug) {
                    continue;
                }
                let read_only = crate::config::is_inherent_skill(&slug);
                items.push(AgentSkillInventoryItem {
                    id: format!("personal:{slug}"),
                    name: slug,
                    source: if read_only { "builtin" } else { "personal" }.into(),
                    version: 0,
                    team_item: false,
                    read_only,
                    health: "installed".into(),
                    error_code: String::new(),
                });
            }
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

/// The one directory name a `personal:{slug}` id may address.
///
/// Rejecting only separators is not enough: `personal:..` has none, survives
/// the lexical `starts_with(root)` check below (`.../skills/..` *does* start
/// with `.../skills`), and then `remove_dir_all` resolves the `..` at the OS
/// level and recursively deletes the parent. Requiring exactly one `Normal`
/// component that is byte-identical to the input rules out `..`, `.`, `a/b`,
/// `/abs`, `C:\x`, and trailing-separator spellings in one check. Backslash is
/// rejected explicitly on top, because Unix would otherwise accept `a\b` as one
/// legal directory name and hand a nested path to a Windows reader.
fn personal_skill_dir_name(item_id: &str) -> Option<&str> {
    use std::path::Component;
    let slug = item_id.strip_prefix("personal:")?;
    if slug.contains('\\') {
        return None;
    }
    let mut components = std::path::Path::new(slug).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if name.as_encoded_bytes() == slug.as_bytes() => {
            Some(slug)
        }
        _ => None,
    }
}

/// `claimed` is the same set the inventory used to decide what this Agent's own
/// skills are. Passing it here rather than re-deriving one is what keeps the two
/// in step: anything this refuses must be absent from that list, or the column
/// grows a row whose delete button can only ever fail.
fn remove_personal_skill(
    item_id: &str,
    claimed: &std::collections::BTreeSet<String>,
) -> Result<(), (&'static str, String)> {
    let slug = personal_skill_dir_name(item_id)
        .ok_or(("invalid_item", "personal skill id is invalid".into()))?;
    if crate::config::is_inherent_skill(slug) {
        return Err((
            "builtin_read_only",
            "built-in skills cannot be removed".into(),
        ));
    }
    let root = dirs::home_dir()
        .ok_or((
            "personal_skill_unavailable",
            "home directory is unavailable".into(),
        ))?
        .join(".agents/skills");
    let path = root.join(slug);
    if !path.starts_with(&root) {
        return Err((
            "invalid_item",
            "personal skill id escapes the global skill root".into(),
        ));
    }
    if claimed.contains(slug) {
        return Err(("not_personal_skill", "team skills require uninstall".into()));
    }
    match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(("personal_skill_remove_failed", e.to_string())),
    }
}

fn mcp_inventory(team_id: &str) -> Vec<crate::proto::teamclu::AgentMcpInventoryItem> {
    use crate::proto::teamclu::AgentMcpInventoryItem;
    let workspace = crate::config::global_team_store::default_workspace_dir(team_id);
    // Seed the device file first, the way the sibling HTTP read path does
    // (`get_mcp` calls `ensure_inherent_mcp`). Without it this list reports
    // whatever a previous runtime spawn happened to have written: a machine
    // whose device file predates `teamclu-introspect` moving there would show
    // no introspect until something *else* triggered a spawn. Idempotent, and a
    // no-op once the entries are present.
    crate::runtime::supervisor::ensure_device_mcp_for_inventory();
    // The merged view, not `scan_team_mcp`: device (`~/.amuxd/mcp.json`), team,
    // and workspace layers with provenance stamped on each entry.
    //
    // Scanning only the team layer and hardcoding `source: "team"` made the two
    // groups the UI renders for the other layers — Built-in and Personal —
    // unreachable by construction, so a machine running four device MCP servers
    // reported an empty inventory and the panel said "No MCP servers yet".
    let merged = match crate::config::team_mcp::load_merged_mcp(&workspace) {
        Ok(merged) => merged,
        Err(e) => {
            warn!(
                workspace = %workspace.display(),
                error = %e,
                "mcp inventory: merged read failed; reporting team layer only"
            );
            crate::config::team_mcp::scan_team_mcp(&workspace)
        }
    };
    let mut items: Vec<_> = merged
        .into_iter()
        .map(|(name, config)| {
            let mut env_keys: Vec<_> = config.environment.keys().cloned().collect();
            let mut header_keys: Vec<_> = config.headers.keys().cloned().collect();
            env_keys.sort();
            header_keys.sort();
            // This response crosses an RPC trust boundary. Arguments and URL
            // paths/query strings can contain literal credentials, so expose
            // only an executable name or URL origin as the configuration
            // summary. Secret-backed env/header fields are names-only below.
            let command_or_url = config.url.as_deref().map_or_else(
                || config.command.first().cloned().unwrap_or_default(),
                |url| {
                    let without_query = url
                        .split(|character| character == '?' || character == '#')
                        .next()
                        .unwrap_or_default();
                    let Some((scheme, remainder)) = without_query.split_once("://") else {
                        return "<remote>".to_string();
                    };
                    let authority = remainder.split('/').next().unwrap_or_default();
                    let host = authority.rsplit('@').next().unwrap_or_default();
                    if scheme.is_empty() || host.is_empty() {
                        "<remote>".to_string()
                    } else {
                        format!("{scheme}://{host}")
                    }
                },
            );
            // Same vocabulary the skill inventory above uses, which is what
            // the client already branches on: team / builtin / personal.
            // Inherent servers are machine-level and rewritten by
            // `ensure_device_mcp`, and this RPC has no update action for them,
            // so they are reported read-only rather than offered as editable.
            let (source, read_only) = match config.source.as_deref() {
                Some("team") => ("team", false),
                Some("inherent") => ("builtin", true),
                _ => ("personal", false),
            };
            AgentMcpInventoryItem {
                id: name.clone(),
                name,
                source: source.into(),
                transport: if config.url.is_some() {
                    "http"
                } else {
                    "stdio"
                }
                .into(),
                command_or_url,
                config_status: "installed".into(),
                runtime_status: "unknown".into(),
                configured_env_keys: env_keys,
                missing_env_keys: vec![],
                configured_header_keys: header_keys,
                missing_header_keys: vec![],
                error_code: String::new(),
                sanitized_error: String::new(),
                read_only,
            }
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items
}

/// Everything `handle_agent_capability_management` needs, all of it cheaply
/// clonable, so the handler can run on its own task instead of holding the
/// daemon's single message pump for the length of a reconcile.
#[derive(Clone)]
pub(crate) struct AgentManagementCtx {
    backend: Arc<dyn crate::backend::Backend>,
    reconciler: Arc<crate::runtime::team_skills::TeamSkillReconciler>,
    refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    refresh_watch_registry:
        Option<Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
    results: Arc<
        AsyncMutex<HashMap<String, (std::time::Instant, crate::proto::teamclu::RpcResponse)>>,
    >,
}

fn management_failure(
    request: &crate::proto::teamclu::RpcRequest,
    code: &str,
    message: String,
) -> crate::proto::teamclu::RpcResponse {
    use crate::proto::teamclu::{rpc_response, AgentCapabilityManagementResult, RpcResponse};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: message,
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::AgentCapabilityManagementResult(
            AgentCapabilityManagementResult {
                capabilities: None,
                skills: vec![],
                mcp_servers: vec![],
                status: "failed".into(),
                error_code: code.into(),
            },
        )),
    }
}

async fn publish_rpc_response(
    publisher: &dyn MessagePublisher,
    res_topic: &str,
    response: &crate::proto::teamclu::RpcResponse,
) {
    info!(
        request_id = %response.request_id,
        %res_topic,
        success = response.success,
        "publishing RpcResponse"
    );
    if let Err(e) = publisher
        .publish(
            res_topic,
            response.encode_to_vec(),
            false,
            teamclu_transport::DeliveryGuarantee::AtLeastOnce,
        )
        .await
    {
        warn!("failed to publish RpcResponse: {}", e);
    }
}

impl DaemonServer {
    /// Server-level RPC dispatch. Decodes the wire payload, matches on Method,
    /// delegates session/idea methods to SessionManager, and handles non-session
    /// methods locally. Publishes the response to the sender's rpc/res topic.
    pub(crate) async fn handle_rpc_request(&mut self, topic: &str, payload: &[u8]) {
        use crate::proto::teamclu::RpcRequest;
        use prost::Message as ProstMessage;

        let request = match RpcRequest::decode(payload) {
            Ok(r) => r,
            Err(e) => {
                warn!(%topic, "failed to decode RpcRequest: {}", e);
                return;
            }
        };

        // Each daemon only subscribes to its own `amux/{team}/{actor}/rpc/req`
        // topic; ignore mis-delivered requests so we never apply another actor's
        // workspace path on this machine.
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5
            && parts[0] == "amux"
            && parts[3] == "rpc"
            && parts[4] == "req"
            && parts[2] != self.actor_id.as_str()
        {
            warn!(
                %topic,
                expected_actor = %self.actor_id,
                "ignoring RpcRequest routed to a different actor"
            );
            return;
        }

        // Publish response on the requester's rpc/res topic (mirrors
        // RpcServer::respond). The requester subscribes on its own actor
        // namespace `amux/{team}/{actor}/rpc/res`.
        let res_topic = self.topics.rpc_res_for(&request.requester_actor_id);

        // Capability management runs a full reconcile — an install downloads
        // every drifted team skill pack — and this is the daemon's ONE message
        // pump: awaiting it inline stalls runtime commands, live-session events
        // and every other client's RPC for the duration. Hand it its own task;
        // it publishes its own response.
        if let Some(crate::proto::teamclu::rpc_request::Method::AgentCapabilityManagement(
            management,
        )) = request.method.clone()
        {
            let ctx = self.agent_management_ctx();
            let publisher = self.publisher_handle.clone();
            tokio::spawn(async move {
                let response =
                    Self::handle_agent_capability_management(&ctx, &request, management).await;
                publish_rpc_response(publisher.as_ref(), &res_topic, &response).await;
            });
            return;
        }

        let response = self.dispatch_rpc_request(request.clone()).await;
        publish_rpc_response(self.publisher_handle.as_ref(), &res_topic, &response).await;
    }

    fn agent_management_ctx(&self) -> AgentManagementCtx {
        AgentManagementCtx {
            backend: self.backend.clone(),
            reconciler: self.team_skill_reconciler.clone(),
            refresh: self.refresh_coordinator.clone(),
            refresh_watch_registry: self.refresh_watch_registry.clone(),
            results: self.agent_management_results.clone(),
        }
    }

    /// Local fast-path dispatch for `POST /v1/rpc`: same decode + method
    /// dispatch as the MQTT `rpc/req` path, but the encoded `RpcResponse`
    /// bytes are returned to the HTTP caller instead of being published to
    /// the requester's `rpc/res` topic. The topic-actor guard in
    /// [`Self::handle_rpc_request`] is unnecessary here — loopback HTTP can
    /// only ever reach this daemon.
    pub(crate) async fn dispatch_local_rpc(&mut self, payload: &[u8]) -> Result<Vec<u8>, String> {
        use crate::proto::teamclu::RpcRequest;
        use prost::Message as ProstMessage;

        let request =
            RpcRequest::decode(payload).map_err(|e| format!("failed to decode RpcRequest: {e}"))?;
        info!(
            request_id = %request.request_id,
            requester_actor_id = %request.requester_actor_id,
            "dispatching local (HTTP) RpcRequest"
        );
        let response = self.dispatch_rpc_request(request).await;
        Ok(response.encode_to_vec())
    }

    /// Transport-agnostic RPC method dispatch shared by the MQTT `rpc/req`
    /// path and the local HTTP `/v1/rpc` path.
    pub(crate) async fn dispatch_rpc_request(
        &mut self,
        request: crate::proto::teamclu::RpcRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_request::Method, RpcResponse};

        match &request.method {
            // ─── Session/idea methods — delegate to SessionManager ───
            Some(Method::CreateSession(_))
            | Some(Method::FetchSession(_))
            | Some(Method::FetchSessionMessages(_))
            | Some(Method::JoinSession(_))
            | Some(Method::AddParticipant(_))
            | Some(Method::RemoveParticipant(_))
            | Some(Method::CreateIdea(_))
            | Some(Method::ClaimIdea(_))
            | Some(Method::SubmitIdea(_))
            | Some(Method::UpdateIdea(_)) => {
                // Pre-compute primary before the mutable borrow of self.teamclu.
                let primary = self.primary_agent_id().await;
                if let Some(tc) = self.teamclu.as_mut() {
                    tc.handle_rpc_method(request.clone(), primary).await
                } else {
                    not_yet_implemented(&request, "session_manager not initialized")
                }
            }
            // ─── Non-session methods — handle locally ───
            // Phase 1b Ideas 3-9 replace these stubs with real handlers.
            Some(Method::FetchPeers(_)) => self.handle_fetch_peers(&request).await,
            Some(Method::FetchWorkspaces(_)) => self.handle_fetch_workspaces(&request).await,
            Some(Method::AnnouncePeer(ann)) => self.handle_announce_peer(&request, ann).await,
            Some(Method::DisconnectPeer(d)) => self.handle_disconnect_peer(&request, d).await,
            Some(Method::AddWorkspace(a)) => self.handle_add_workspace(&request, a).await,
            Some(Method::RemoveWorkspace(r)) => self.handle_remove_workspace(&request, r).await,
            Some(Method::RemoveMember(r)) => self.handle_remove_member(&request, r).await,
            Some(Method::RuntimeStop(s)) => self.handle_stop_runtime(&request, s).await,
            Some(Method::RuntimeStart(s)) => self.handle_start_runtime(&request, s).await,
            Some(Method::SetModel(s)) => self.handle_set_model(&request, s).await,
            Some(Method::RuntimeCommand(c)) => {
                self.handle_runtime_command_rpc(&request, c.clone()).await
            }
            Some(Method::AgentCapabilityManagement(m)) => {
                // Inline here on purpose: this arm is only reached from the
                // local HTTP path, which already runs on its own task. The MQTT
                // path spawns instead — see `handle_rpc_request`.
                Self::handle_agent_capability_management(
                    &self.agent_management_ctx(),
                    &request,
                    m.clone(),
                )
                .await
            }
            Some(Method::RemoteToolInvoke(_)) => not_yet_implemented(
                &request,
                "RemoteToolInvoke is handled by clients, not daemon",
            ),
            None => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: "no method".to_string(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: None,
            },
        }
    }

    async fn handle_agent_capability_management(
        ctx: &AgentManagementCtx,
        request: &crate::proto::teamclu::RpcRequest,
        management: crate::proto::teamclu::AgentCapabilityManagementRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{
            rpc_response, AgentCapabilityAction, AgentCapabilityKind,
            AgentCapabilityManagementResult, AgentManagementCapabilities, RpcResponse,
        };

        const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
        // Sized so eviction cannot realistically happen inside a grant's 60s
        // life: while an entry survives, a replay of its grant returns the
        // recorded answer instead of re-running the mutation, and that is what
        // makes a grant single-use (see `nonce` in the Cloud API contract).
        const CACHE_LIMIT: usize = 1024;

        let action = AgentCapabilityAction::try_from(management.action)
            .unwrap_or(AgentCapabilityAction::Unspecified);
        let kind = AgentCapabilityKind::try_from(management.kind)
            .unwrap_or(AgentCapabilityKind::Unspecified);
        let scope = match (action, kind) {
            (AgentCapabilityAction::GetCapabilities, _) => "capabilities:read",
            (AgentCapabilityAction::ListInventory, AgentCapabilityKind::AgentSkill) => {
                "skills:list"
            }
            (AgentCapabilityAction::InstallTeamItem, AgentCapabilityKind::AgentSkill) => {
                "skills:install"
            }
            (AgentCapabilityAction::UninstallTeamItem, AgentCapabilityKind::AgentSkill) => {
                "skills:uninstall"
            }
            (AgentCapabilityAction::RetryItem, AgentCapabilityKind::AgentSkill) => "skills:retry",
            (AgentCapabilityAction::RemovePersonalSkill, AgentCapabilityKind::AgentSkill) => {
                "skills:remove-personal"
            }
            (AgentCapabilityAction::ListInventory, AgentCapabilityKind::AgentMcp) => "mcp:list",
            (AgentCapabilityAction::InstallTeamItem, AgentCapabilityKind::AgentMcp) => {
                "mcp:install"
            }
            (AgentCapabilityAction::UninstallTeamItem, AgentCapabilityKind::AgentMcp) => {
                "mcp:uninstall"
            }
            (AgentCapabilityAction::RetryItem, AgentCapabilityKind::AgentMcp) => "mcp:retry",
            _ => "",
        };

        // Validate and authorize BEFORE the response cache is consulted. The
        // cache is keyed on `request_id` + `requester_actor_id`, both of which
        // are unauthenticated payload fields: reading it first handed anyone
        // able to publish to this Agent's `rpc/req` topic a previous
        // requester's full skill and MCP inventory, with no grant presented and
        // no `management_forbidden` line in the log.
        let request_id = request.request_id.trim();
        if request_id.is_empty() {
            return management_failure(request, "invalid_request", "request_id is required".into());
        }
        if scope.is_empty() {
            return management_failure(
                request,
                "unsupported_operation",
                "unsupported capability operation".into(),
            );
        }
        if let Err(e) = ctx
            .backend
            .verify_agent_management_grant(
                &management.management_grant,
                scope,
                &request.requester_actor_id,
                request_id,
            )
            .await
        {
            return management_failure(request, "management_forbidden", e.to_string());
        }

        // Past this point the caller has proved a grant Cloud API minted for
        // exactly this requester and this request id, so the entry recorded
        // under that key is theirs to read.
        let cache_key = format!("{}:{}", request.requester_actor_id, request_id);
        {
            let mut cache = ctx.results.lock().await;
            cache.retain(|_, (created, _)| created.elapsed() < CACHE_TTL);
            if let Some((_, cached)) = cache.get(&cache_key) {
                return cached.clone();
            }
        }

        let result = async {
            let capabilities = AgentManagementCapabilities {
                protocol_version: 1,
                skill_actions: vec![
                    AgentCapabilityAction::ListInventory as i32,
                    AgentCapabilityAction::InstallTeamItem as i32,
                    AgentCapabilityAction::UninstallTeamItem as i32,
                    AgentCapabilityAction::RetryItem as i32,
                    AgentCapabilityAction::RemovePersonalSkill as i32,
                ],
                mcp_actions: vec![
                    AgentCapabilityAction::ListInventory as i32,
                    AgentCapabilityAction::InstallTeamItem as i32,
                    AgentCapabilityAction::UninstallTeamItem as i32,
                    AgentCapabilityAction::RetryItem as i32,
                ],
            };

            if action == AgentCapabilityAction::GetCapabilities {
                return Ok(AgentCapabilityManagementResult {
                    capabilities: Some(capabilities),
                    skills: vec![],
                    mcp_servers: vec![],
                    status: "ok".into(),
                    error_code: String::new(),
                });
            }

            let team_id = ctx.backend.team_id().trim().to_string();
            if team_id.is_empty() {
                return Err((
                    "agent_not_onboarded",
                    "Agent is not onboarded to a team".to_string(),
                ));
            }

            match (action, kind) {
                (AgentCapabilityAction::InstallTeamItem, AgentCapabilityKind::AgentSkill) => {
                    if management.item_id.trim().is_empty() || management.version < 1 {
                        return Err((
                            "invalid_item",
                            "skill id and version are required".to_string(),
                        ));
                    }
                    ctx.backend
                        .record_team_skill_install(
                            &team_id,
                            &management.item_id,
                            management.version,
                        )
                        .await
                        .map_err(|e| ("desired_state_write_failed", e.to_string()))?;
                    let outcome = ctx.reconciler.reconcile_now(&team_id).await;
                    crate::runtime::team_skills::apply_team_skill_outcome(
                        &team_id,
                        outcome,
                        Some(&ctx.backend),
                        ctx.refresh.as_ref(),
                        ctx.refresh_watch_registry.as_ref(),
                    )
                    .await;
                }
                (AgentCapabilityAction::UninstallTeamItem, AgentCapabilityKind::AgentSkill) => {
                    ctx.backend
                        .remove_team_skill_install(&team_id, &management.item_id)
                        .await
                        .map_err(|e| ("desired_state_write_failed", e.to_string()))?;
                    let outcome = ctx.reconciler.reconcile_now(&team_id).await;
                    crate::runtime::team_skills::apply_team_skill_outcome(
                        &team_id,
                        outcome,
                        Some(&ctx.backend),
                        ctx.refresh.as_ref(),
                        ctx.refresh_watch_registry.as_ref(),
                    )
                    .await;
                }
                (AgentCapabilityAction::RetryItem, AgentCapabilityKind::AgentSkill) => {
                    let outcome = ctx.reconciler.reconcile_now(&team_id).await;
                    crate::runtime::team_skills::apply_team_skill_outcome(
                        &team_id,
                        outcome,
                        Some(&ctx.backend),
                        ctx.refresh.as_ref(),
                        ctx.refresh_watch_registry.as_ref(),
                    )
                    .await;
                }
                (AgentCapabilityAction::RemovePersonalSkill, AgentCapabilityKind::AgentSkill) => {
                    // Fetched rather than assumed: "is this the Agent's own?" is
                    // the registry's answer, and it has to be the same answer the
                    // list this delete came from was built on.
                    let rows = ctx
                        .backend
                        .team_skills(&team_id)
                        .await
                        .map_err(|e| ("inventory_failed", e.to_string()))?;
                    remove_personal_skill(&management.item_id, &claimed_slugs(&rows))?;
                }
                (AgentCapabilityAction::InstallTeamItem, AgentCapabilityKind::AgentMcp) => {
                    ctx.backend
                        .install_team_mcp(&team_id, &management.item_id)
                        .await
                        .map_err(|e| ("desired_state_write_failed", e.to_string()))?;
                    let outcome = crate::runtime::team_cloud_config::TeamCloudConfigResolver::new(
                        ctx.backend.clone(),
                    )
                    .reconcile_now(&team_id)
                    .await;
                    crate::runtime::team_cloud_config::apply_team_cloud_outcome(
                        &team_id,
                        outcome,
                        Some(&ctx.backend),
                        ctx.refresh.as_ref(),
                    )
                    .await;
                }
                (AgentCapabilityAction::UninstallTeamItem, AgentCapabilityKind::AgentMcp) => {
                    ctx.backend
                        .uninstall_team_mcp(&team_id, &management.item_id)
                        .await
                        .map_err(|e| ("desired_state_write_failed", e.to_string()))?;
                    let outcome = crate::runtime::team_cloud_config::TeamCloudConfigResolver::new(
                        ctx.backend.clone(),
                    )
                    .reconcile_now(&team_id)
                    .await;
                    crate::runtime::team_cloud_config::apply_team_cloud_outcome(
                        &team_id,
                        outcome,
                        Some(&ctx.backend),
                        ctx.refresh.as_ref(),
                    )
                    .await;
                }
                (AgentCapabilityAction::RetryItem, AgentCapabilityKind::AgentMcp) => {
                    let outcome = crate::runtime::team_cloud_config::TeamCloudConfigResolver::new(
                        ctx.backend.clone(),
                    )
                    .reconcile_now(&team_id)
                    .await;
                    crate::runtime::team_cloud_config::apply_team_cloud_outcome(
                        &team_id,
                        outcome,
                        Some(&ctx.backend),
                        ctx.refresh.as_ref(),
                    )
                    .await;
                }
                (AgentCapabilityAction::ListInventory, _) => {}
                _ => {
                    return Err((
                        "unsupported_operation",
                        "unsupported capability operation".to_string(),
                    ))
                }
            }

            let (skills, mcp_servers) = match kind {
                AgentCapabilityKind::AgentSkill => (
                    skill_inventory(ctx.backend.as_ref(), &team_id)
                        .await
                        .map_err(|e| ("inventory_failed", e))?,
                    vec![],
                ),
                AgentCapabilityKind::AgentMcp => (vec![], mcp_inventory(&team_id)),
                _ => (vec![], vec![]),
            };
            Ok(AgentCapabilityManagementResult {
                capabilities: Some(capabilities),
                skills,
                mcp_servers,
                status: "ok".into(),
                error_code: String::new(),
            })
        }
        .await;

        let response = match result {
            Ok(value) => RpcResponse {
                request_id: request.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::AgentCapabilityManagementResult(value)),
            },
            Err((code, message)) => management_failure(request, code, message),
        };
        {
            let mut cache = ctx.results.lock().await;
            if cache.len() >= CACHE_LIMIT {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, (created, _))| *created)
                    .map(|(id, _)| id.clone())
                {
                    cache.remove(&oldest);
                }
            }
            cache.insert(cache_key, (std::time::Instant::now(), response.clone()));
        }
        response
    }

    pub(crate) fn session_title_for_log(&self, session_id: &str) -> String {
        self.teamclu
            .as_ref()
            .and_then(|tc| tc.sessions.find_by_id(session_id))
            .map(|session| session.title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or("<unknown>")
            .to_string()
    }

    pub(crate) async fn handle_incoming(
        &mut self,
        msg: subscriber::IncomingMessage,
    ) -> super::command_executor::HandlerOutcome {
        use prost::Message as ProstMessage;
        match msg {
            subscriber::IncomingMessage::RuntimeCommand {
                actor_id,
                runtime_id,
                envelope,
            } => {
                // Topic segment may be a spawn key, cloud session id, or
                // `{actor}::{session}` (ADR-0004). Resolve before cancel.
                // Prefer envelope.actor_id (target agent); fall back to topic.
                let resolve_actor = if !envelope.actor_id.trim().is_empty() {
                    envelope.actor_id.trim()
                } else {
                    actor_id.trim()
                };
                let resolved = {
                    let agents = self.agents.lock().await;
                    agents.resolve_command_agent_id(&runtime_id, resolve_actor)
                };
                match resolved {
                    Some(agent_id) => {
                        if agent_id != runtime_id {
                            info!(
                                addressed = %runtime_id,
                                %agent_id,
                                "resolved runtime command address to spawn key"
                            );
                        }
                        self.handle_agent_command(&agent_id, envelope).await;
                    }
                    None => {
                        warn!(
                            addressed = %runtime_id,
                            "runtime command address resolved to no agent; dropping"
                        );
                    }
                }
            }
            subscriber::IncomingMessage::TeamcluRpc { topic, payload } => {
                self.handle_rpc_request(&topic, &payload).await;
            }
            subscriber::IncomingMessage::TeamcluRpcResponse { topic, payload } => {
                let _ = self
                    .rpc_client
                    .lock()
                    .await
                    .handle_response(&topic, &payload);
            }
            subscriber::IncomingMessage::TeamcluSessionLive {
                session_id,
                payload,
            } => {
                let session_title = self.session_title_for_log(&session_id);
                let daemon_config_actor_id = self.config.actor.id.as_str();
                let daemon_actor_id = self.actor_id.as_str();
                let daemon_team_id = self.config.team_id.as_deref().unwrap_or("<none>");
                info!(
                    session_id = %session_id,
                    session_title = %session_title,
                    daemon_config_actor_id = %daemon_config_actor_id,
                    daemon_actor_id = %daemon_actor_id,
                    daemon_team_id = %daemon_team_id,
                    payload_bytes = payload.len(),
                    "session/live message received"
                );
                let envelope_res =
                    crate::proto::teamclu::LiveEventEnvelope::decode(payload.as_slice());
                if let Err(e) = &envelope_res {
                    warn!(
                        session_id = %session_id,
                        session_title = %session_title,
                        daemon_config_actor_id = %daemon_config_actor_id,
                        daemon_actor_id = %daemon_actor_id,
                        daemon_team_id = %daemon_team_id,
                        err = %e,
                        "LiveEventEnvelope decode FAILED"
                    );
                }
                if let Ok(envelope) = envelope_res {
                    info!(
                        session_id = %session_id,
                        session_title = %session_title,
                        daemon_config_actor_id = %daemon_config_actor_id,
                        daemon_actor_id = %daemon_actor_id,
                        daemon_team_id = %daemon_team_id,
                        event_type = %envelope.event_type,
                        event_id = %envelope.event_id,
                        body_bytes = envelope.body.len(),
                        "LiveEventEnvelope decoded"
                    );
                    match envelope.event_type.as_str() {
                        "message.created" => {
                            let env = match crate::proto::teamclu::SessionMessageEnvelope::decode(
                                envelope.body.as_slice(),
                            ) {
                                Ok(e) => e,
                                Err(e) => {
                                    warn!(
                                        session_id = %session_id,
                                        session_title = %session_title,
                                        daemon_config_actor_id = %daemon_config_actor_id,
                                        daemon_actor_id = %daemon_actor_id,
                                        daemon_team_id = %daemon_team_id,
                                        err = %e,
                                        "SessionMessageEnvelope decode failed"
                                    );
                                    return super::command_executor::HandlerOutcome::Permanent {
                                        reason: format!("invalid SessionMessageEnvelope: {e}"),
                                    };
                                }
                            };
                            let Some(msg) = env.message.as_ref() else {
                                warn!(
                                    session_id = %session_id,
                                    session_title = %session_title,
                                    daemon_config_actor_id = %daemon_config_actor_id,
                                    daemon_actor_id = %daemon_actor_id,
                                    daemon_team_id = %daemon_team_id,
                                    "SessionMessageEnvelope without inner message; dropping"
                                );
                                return super::command_executor::HandlerOutcome::Permanent {
                                    reason: "SessionMessageEnvelope has no message".to_string(),
                                };
                            };
                            // Dedup is enforced centrally in
                            // `route_session_message_to_runtimes` (the single
                            // routing sink) so the live path and the
                            // catchup-replay path share one message_id gate and
                            // a freshly-sent message can't be prompted twice.
                            self.route_session_message(
                                &session_id,
                                msg,
                                &resolve_mention_actor_ids(
                                    &env.mention_actor_ids,
                                    &msg.metadata_json,
                                ),
                            )
                            .await;
                        }
                        "idea.created" | "idea.updated" => {
                            if let Ok(event) =
                                crate::proto::teamclu::IdeaEvent::decode(envelope.body.as_slice())
                            {
                                if let Some(tc) = &mut self.teamclu {
                                    if !tc.should_process_idea_event(&session_id, &event) {
                                        return super::command_executor::HandlerOutcome::Success;
                                    }
                                }
                                if let Some(tc) = &self.teamclu {
                                    let activated =
                                        tc.agents_to_activate_for_idea(&session_id, &event);
                                    for agent_actor_id in activated {
                                        if let Some(runtime_id) = self
                                            .runtime_id_for_agent_actor_in_session(
                                                &agent_actor_id,
                                                &session_id,
                                            )
                                            .await
                                        {
                                            let prompt = format_idea_prompt(&session_id, &event);
                                            if !prompt.is_empty() {
                                                let send_res = self
                                                    .agents
                                                    .lock()
                                                    .await
                                                    .send_prompt(&runtime_id, &prompt, vec![])
                                                    .await;
                                                if let Err(e) = send_res {
                                                    warn!(
                                                        "Failed to route live idea to agent {} runtime {}: {}",
                                                        agent_actor_id, runtime_id, e
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                } else {
                    return super::command_executor::HandlerOutcome::Permanent {
                        reason: "invalid LiveEventEnvelope".to_string(),
                    };
                }
            }
            subscriber::IncomingMessage::TeamcluNotify { actor_id, payload } => {
                match crate::proto::teamclu::Notify::decode(payload.as_slice()) {
                    Ok(n) => {
                        if n.event_type == "membership.refresh" && !n.refresh_hint.is_empty() {
                            match self
                                .backend
                                .fetch_session_with_participants(&n.refresh_hint)
                                .await
                            {
                                Ok(snap) => {
                                    if let Some(tc) = &mut self.teamclu {
                                        if let Err(err) = tc
                                            .insert_session_from_backend(
                                                &snap.session,
                                                &snap.participants,
                                            )
                                            .await
                                        {
                                            warn!(
                                                ?err,
                                                actor_id = %actor_id,
                                                session_id = %n.refresh_hint,
                                                "failed to ingest cloud session after membership.refresh notify"
                                            );
                                            return super::command_executor::HandlerOutcome::Retryable {
                                                reason: format!("failed to ingest membership refresh: {err}"),
                                            };
                                        }
                                    }
                                }
                                Err(err) => {
                                    warn!(
                                        ?err,
                                        actor_id = %actor_id,
                                        session_id = %n.refresh_hint,
                                        "failed to fetch cloud session after membership.refresh notify"
                                    );
                                    return super::command_executor::HandlerOutcome::Retryable {
                                        reason: format!("membership refresh fetch failed: {err}"),
                                    };
                                }
                            }
                        }
                    }
                    Err(err) => {
                        warn!(?err, "failed to decode actor notify payload as Notify");
                        return super::command_executor::HandlerOutcome::Permanent {
                            reason: format!("invalid Notify: {err}"),
                        };
                    }
                }
            }
            subscriber::IncomingMessage::SyncHint {
                team_id,
                resource,
                payload,
            } => {
                self.sync_dispatcher
                    .handle_sync_hint(self.backend.team_id(), &team_id, &resource, &payload)
                    .await;
            }
        }
        super::command_executor::HandlerOutcome::Success
    }

    /// Derive the caller's MemberRole via a cloud `agent_member_access`
    /// lookup keyed on (our own agent actor id, envelope's sender_actor_id).
    /// the cloud backend is the sole source of truth — on any failure (RPC error,
    /// missing sender_actor_id) the caller is denied (`Member` is the safe
    /// no-op level). Previous versions fell back to a `peer_id` token-prefix
    /// scrape against members.toml, which let anyone who guessed a 6-char
    /// prefix masquerade as a member during a cloud backend outage; that path
    /// is gone.
    pub(crate) async fn resolve_role(
        &mut self,
        sender_actor_id: &str,
        _peer_id: &str,
    ) -> amux::MemberRole {
        if sender_actor_id.is_empty() {
            warn!("resolve_role: empty sender_actor_id, denying as Member");
            return amux::MemberRole::Member;
        }
        let sb = &self.backend;
        let my_agent_id = sb.actor_id().to_string();
        match sb
            .check_agent_permission(&my_agent_id, sender_actor_id)
            .await
        {
            Ok(Some(level)) => match level.as_str() {
                "admin" => amux::MemberRole::Owner,
                _ => amux::MemberRole::Member,
            },
            Ok(None) => {
                warn!(actor_id = %sender_actor_id, "no agent_member_access grant");
                amux::MemberRole::Member
            }
            Err(e) => {
                warn!(%e, actor_id = %sender_actor_id, "cloud permission check failed; denying");
                amux::MemberRole::Member
            }
        }
    }

    /// Session-addressed twin of [`Self::handle_agent_command`], reached over
    /// `rpc/req` instead of the per-spawn commands topic.
    ///
    /// The whole point is the reply: the old topic had no response path, so a
    /// command aimed at a spawn this daemon no longer knows was dropped with
    /// nothing but a `warn!` — the user saw a stop button that did nothing
    /// (docs/debug/interrupt-agent-stale-runtime.md). Here, "no Attachment for
    /// that session" is an answer the caller receives.
    pub(crate) async fn handle_runtime_command_rpc(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        command: crate::proto::teamclu::RuntimeCommandRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, RpcResponse, RuntimeCommandResult};

        let session_id = command.session_id.trim().to_string();
        if session_id.is_empty() {
            return RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: "runtime_command requires session_id".into(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: None,
            };
        }

        let Some(envelope) = command.envelope else {
            return RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: "runtime_command requires envelope".into(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: None,
            };
        };

        let resolve_actor = if !envelope.actor_id.trim().is_empty() {
            envelope.actor_id.trim().to_string()
        } else {
            self.actor_id.clone()
        };
        let agent_id = {
            let agents = self.agents.lock().await;
            agents
                .attachment_for_session_actor(&session_id, &resolve_actor)
                .map(|h| h.agent_id.clone())
        };

        let Some(agent_id) = agent_id else {
            // Not an error: the session is simply cold. The caller needs to
            // know the difference so it can stop waiting for a state change
            // that will never arrive.
            return RpcResponse {
                request_id: request.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeCommandResult(
                    RuntimeCommandResult { dispatched: false },
                )),
            };
        };

        self.handle_agent_command(&agent_id, envelope).await;

        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RuntimeCommandResult(
                RuntimeCommandResult { dispatched: true },
            )),
        }
    }

    pub(crate) async fn handle_agent_command(
        &mut self,
        agent_id: &str,
        envelope: amux::RuntimeCommandEnvelope,
    ) {
        let peer_id = envelope.peer_id.clone();
        let command_id = envelope.command_id.clone();
        let sender_actor_id = envelope.sender_actor_id.clone();
        let reply_actor_id = if envelope.reply_to_actor_id.is_empty() {
            envelope.actor_id.clone()
        } else {
            envelope.reply_to_actor_id.clone()
        };

        let acp_command = match envelope.acp_command {
            Some(c) => c,
            None => return,
        };
        let cmd = match acp_command.command {
            Some(c) => c,
            None => return,
        };

        // Permission check.
        // Preferred path: iOS sets `sender_actor_id` on the envelope, daemon
        // looks up `agent_member_access.permission_level` via the cloud backend and
        // reduces that to a MemberRole. Legacy path: fall back to the
        // peer's MQTT-era role when the cloud backend lookup is unavailable.
        let role = self.resolve_role(&sender_actor_id, &peer_id).await;

        if let Err(reason) = self.permissions.check_command_permission(role, &cmd) {
            warn!(
                peer_id,
                reply_actor_id = %reply_actor_id,
                command_id = %command_id,
                %reason,
                "command rejected; legacy collab NACK no longer published"
            );
            return;
        }

        match cmd {
            amux::acp_command::Command::StartAgent(start) => {
                let requested =
                    amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::Unknown);
                let at = resolve_requested_agent_type(&self.config, requested);

                info!(
                    workspace_id = %start.workspace_id,
                    worktree = %start.worktree,
                    peer_id,
                    "received startAgent envelope"
                );

                let outcome = self
                    .apply_start_runtime(
                        at,
                        &start.workspace_id,
                        &start.worktree,
                        &start.session_id,
                        &start.initial_prompt,
                None,
                &sender_actor_id,
                false,
            )
            .await;

                match outcome {
                    Ok(res) => {
                        info!(
                            agent_id = %res.runtime_id,
                            peer_id,
                            reply_actor_id = %reply_actor_id,
                            command_id = %command_id,
                            session_id = %res.session_id,
                            "agent started; legacy collab AgentStartResult no longer published"
                        );
                    }
                    Err(err) => {
                        let reason = err.error_message.clone();
                        error!(
                            peer_id,
                            reply_actor_id = %reply_actor_id,
                            command_id = %command_id,
                            session_id = %start.session_id,
                            "startAgent failed: {}; legacy collab AgentStartResult no longer published",
                            reason
                        );
                    }
                }
            }

            amux::acp_command::Command::StopAgent(_) => {
                let stopped = self
                    .agents
                    .lock()
                    .await
                    .stop_runtime(agent_id)
                    .await
                    .is_some();
                if stopped {
                    self.remote_tool_turn_contexts
                        .lock()
                        .await
                        .clear_runtime(agent_id);
                    self.publish_runtime_detached(agent_id).await;
                    info!(agent_id, peer_id, "agent stopped");
                }
            }

            amux::acp_command::Command::SendPrompt(prompt) => {
                let needs_resume = self.agents.lock().await.get_handle(agent_id).is_none();
                if needs_resume {
                    let session_id = agent_id.to_string();
                    let agent_type = {
                        let agents = self.agents.lock().await;
                        agents.default_agent_type()
                    };
                    let workspace_id = self
                        .resolve_collab_workspace_id(&session_id)
                        .await
                        .or_else(|| {
                            self.resolve_binding_workspace_for_cold_attach(
                                &session_id,
                                agent_type,
                                None,
                            )
                        });
                    if let Some(workspace_id) = workspace_id {
                        match self
                            .attach_collab_from_binding(
                                &session_id,
                                agent_type,
                                &workspace_id,
                                "",
                                None,
                                true,
                                Some(&sender_actor_id),
                                "legacy_send_prompt",
                            )
                            .await
                        {
                            Ok(None) => {}
                            Ok(Some(_)) => {}
                            Err(err) => {
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(
                                            amux::session_event::Event::PromptRejected(
                                                amux::PromptRejected {
                                                    command_id,
                                                    reason: err.error_message,
                                                },
                                            ),
                                        ),
                                    },
                                )
                                .await;
                                return;
                            }
                        }
                    }
                }

                // Check busy
                let busy_reject: Option<String> = {
                    let agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle(agent_id) {
                        self.permissions.check_agent_busy(handle.status).err()
                    } else {
                        None
                    }
                };
                if let Some(reason) = busy_reject {
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PromptRejected(
                                amux::PromptRejected { command_id, reason },
                            )),
                        },
                    )
                    .await;
                    return;
                }

                // If the client requested a specific model and it differs from
                // the one we last applied, forward a SetModel command before
                // the prompt so the new turn runs on the requested model.
                let desired_model = prompt.model_id.clone();
                let mut model_changed = false;
                if !desired_model.is_empty() {
                    let current = self
                        .agents
                        .lock()
                        .await
                        .current_model(agent_id)
                        .cloned()
                        .unwrap_or_default();
                    if desired_model != current {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(agent_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(agent_id, &desired_model);
                                model_changed = true;
                            }
                            Err(e) => {
                                warn!(agent_id, model_id = %desired_model, "send_set_model failed: {}", e);
                            }
                        }
                    }
                }
                if model_changed {
                    self.publish_runtime_state_by_id(agent_id).await;
                }

                // Send prompt to agent (respawns if process exited)
                let session_id = self
                    .agents
                    .lock()
                    .await
                    .get_handle(agent_id)
                    .map(|h| h.session_id.clone())
                    .unwrap_or_default();
                self.prepare_remote_tool_context_for_turn(agent_id, &session_id, &sender_actor_id)
                    .await;
                let requester = (!sender_actor_id.is_empty()).then(|| sender_actor_id.clone());
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt_with_requester(
                        agent_id,
                        &prompt.text,
                        prompt.attachment_urls.clone(),
                        requester,
                        None,
                    )
                    .await;
                match send_res {
                    Ok(_drained) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Active;
                                handle.current_prompt = prompt.text.clone();
                            }
                        }
                        info!(agent_id, peer_id, "prompt sent to agent");
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptAccepted(
                                    amux::PromptAccepted { command_id },
                                )),
                            },
                        )
                        .await;
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to send prompt: {}", e);
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptRejected(
                                    amux::PromptRejected {
                                        command_id,
                                        reason: format!("failed to send prompt: {}", e),
                                    },
                                )),
                            },
                        )
                        .await;
                    }
                }
            }

            amux::acp_command::Command::Cancel(_) => {
                let cancel_res = self.agents.lock().await.cancel_agent(agent_id).await;
                match cancel_res {
                    Ok(()) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Idle;
                            }
                        }
                        info!(agent_id, peer_id, "agent cancelled via ACP");
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to cancel agent: {}", e);
                    }
                }
            }

            amux::acp_command::Command::GrantPermission(grant) => {
                let grant_option_id =
                    (!grant.option_id.is_empty()).then(|| grant.option_id.clone());
                if self.permissions.try_resolve_permission(&grant.request_id) {
                    // Resolve via ACP permission response
                    match self
                        .agents
                        .lock()
                        .await
                        .resolve_permission_for_topic(
                            agent_id,
                            &grant.request_id,
                            true,
                            grant_option_id,
                        )
                        .await
                    {
                        Ok(()) => {
                            info!(request_id = %grant.request_id, peer_id, agent_id, "permission granted via ACP");
                        }
                        Err(e) => {
                            warn!(
                                request_id = %grant.request_id,
                                peer_id,
                                agent_id,
                                error = %e,
                                "resolve_permission failed after grant; ACP may stay blocked"
                            );
                        }
                    }
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: grant.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: true,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::AnswerQuestion(ans) => {
                match self
                    .agents
                    .lock()
                    .await
                    .answer_question_for_topic(
                        agent_id,
                        &ans.request_id,
                        &ans.answers_json,
                        ans.reject,
                    )
                    .await
                {
                    Ok(()) => {
                        info!(request_id = %ans.request_id, peer_id, agent_id, reject = ans.reject, "question answered");
                    }
                    Err(e) => {
                        warn!(
                            request_id = %ans.request_id,
                            peer_id,
                            agent_id,
                            error = %e,
                            "answer_question failed"
                        );
                    }
                }
            }

            amux::acp_command::Command::DenyPermission(deny) => {
                if self.permissions.try_resolve_permission(&deny.request_id) {
                    // Resolve via ACP permission response
                    match self
                        .agents
                        .lock()
                        .await
                        .resolve_permission_for_topic(agent_id, &deny.request_id, false, None)
                        .await
                    {
                        Ok(()) => {
                            info!(request_id = %deny.request_id, peer_id, agent_id, "permission denied via ACP");
                        }
                        Err(e) => {
                            warn!(
                                request_id = %deny.request_id,
                                peer_id,
                                agent_id,
                                error = %e,
                                "resolve_permission failed after deny"
                            );
                        }
                    }
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: deny.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: false,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::RequestHistory(req) => {
                use prost::Message;
                let page_size = if req.page_size == 0 {
                    50
                } else {
                    req.page_size
                };
                let (mut events, mut has_more) =
                    self.history
                        .read_page(agent_id, req.after_sequence, page_size);

                // Keep history replies under a conservative 10 KB publish
                // budget. Trim the batch by estimated encoded length so we never
                // produce a publish the broker will reject (which otherwise
                // forces the daemon's MQTT client to reconnect and knocks
                // every iOS peer offline in a loop).
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                let next_seq = events
                    .last()
                    .map(|e| e.sequence)
                    .unwrap_or(req.after_sequence);
                info!(
                    agent_id,
                    peer_id,
                    after_seq = req.after_sequence,
                    count = events.len(),
                    has_more,
                    "history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: next_seq,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }

            amux::acp_command::Command::RequestTurnHistory(req) => {
                use prost::Message;
                let mut events = self.history.read_turn(agent_id, &req.turn_id);
                let mut has_more = false;

                // Same 10 KB publish budget as RequestHistory. Turns are
                // usually small (tens of events) so a single batch covers
                // them. If a turn ever grows past the budget, trim the tail
                // and set has_more — iOS sees a partial turn and the local
                // streaming cache fills the gap until we add per-turn
                // pagination.
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                info!(
                    agent_id,
                    peer_id,
                    turn_id = %req.turn_id,
                    count = events.len(),
                    has_more,
                    "turn history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: 0,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }
        }
    }

    /// Publish a session event (e.g. HistoryBatch reply) onto the same
    /// canonical sink as agent-originated envelopes. Reuses
    /// `publish_envelope_to_sessions` so HistoryBatch responses land on
    /// `session/{sid}/live` next to the streaming output that triggered
    /// them — iOS subscribes there exclusively.
    pub(crate) async fn publish_session_event(&self, agent_id: &str, event: amux::SessionEvent) {
        // Session-level events (HistoryBatch reply, etc.) are not part of an
        // ACP turn; leave turn_id empty. iOS does not dedupe session events
        // by turn anyway.
        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            actor_id: self.config.actor.id.clone(),
            source_peer_id: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
            sequence: 0,
            turn_id: String::new(),
            acp_session_id: String::new(),
            payload: Some(amux::envelope::Payload::SessionEvent(event)),
        };
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    // ─── Non-session RPC handlers ───
}

#[cfg(test)]
mod agent_management_tests {
    use super::{claimed_slugs, mcp_inventory, personal_skill_dir_name, remove_personal_skill};
    use crate::backend::TeamSkillRow;
    use std::collections::BTreeSet;

    fn row(slug: &str, installed: bool) -> TeamSkillRow {
        TeamSkillRow {
            slug: slug.to_owned(),
            installed,
            ..Default::default()
        }
    }

    /// Only an *installed* row speaks for a slug. A skill the team publishes but
    /// this Agent never installed leaves any same-named directory on disk the
    /// Agent's own — the team branch skips that row, so the personal branch has
    /// to report it or nothing will.
    #[test]
    fn only_installed_rows_claim_a_slug() {
        let claimed = claimed_slugs(&[row("installed-one", true), row("offered-only", false)]);
        assert!(claimed.contains("installed-one"));
        assert!(!claimed.contains("offered-only"));
    }

    /// The pack the customer lost: shared from this machine, so it carries a
    /// `registry: "team"` origin, but the install was recorded against the member
    /// actor and no row of the Agent's claims it. Judging by the origin made it
    /// vanish; judging by the claim keeps it visible as the Agent's own.
    #[test]
    fn an_unclaimed_pack_stays_the_agents_own_whatever_its_origin_says() {
        let claimed = claimed_slugs(&[row("something-else", true)]);
        assert!(!claimed.contains("spr-investigate-auto"));
    }

    /// Delete has to refuse exactly what the list withheld, and nothing more.
    #[test]
    fn remove_refuses_only_the_slugs_the_team_branch_reported() {
        let claimed: BTreeSet<String> = ["team-owned".to_owned()].into_iter().collect();

        let refused = remove_personal_skill("personal:team-owned", &claimed);
        assert_eq!(refused.unwrap_err().0, "not_personal_skill");

        // Unclaimed: allowed past the guard. It fails later on a missing
        // directory, which is a different, honest error.
        let allowed = remove_personal_skill("personal:unclaimed-pack", &claimed);
        assert!(!matches!(allowed, Err(("not_personal_skill", _))));
    }

    #[test]
    fn personal_skill_ids_address_exactly_one_directory() {
        assert_eq!(personal_skill_dir_name("personal:research"), Some("research"));
        assert_eq!(
            personal_skill_dir_name("personal:my.skill-2"),
            Some("my.skill-2")
        );
    }

    #[test]
    fn personal_skill_ids_cannot_escape_the_skill_root() {
        // `..` has no separator, so the old separator-only filter let it
        // through; `remove_dir_all` then resolved it and deleted ~/.agents.
        for id in [
            "personal:..",
            "personal:.",
            "personal:",
            "personal:../..",
            "personal:a/b",
            "personal:a\\b",
            "personal:/etc",
            "personal:research/",
            "research",
        ] {
            assert_eq!(personal_skill_dir_name(id), None, "{id} must be rejected");
        }
    }

    /// The device layer, the workspace layer, and their provenance all have to
    /// survive the trip through the RPC — the panel renders one group per
    /// source, and a hardcoded `source: "team"` made two of those groups
    /// unreachable no matter what the machine actually had installed.
    #[test]
    fn mcp_inventory_reports_device_and_workspace_servers_with_their_source() {
        // Not a bare `set_var("HOME", …)`: this guard holds the same lock and
        // restores the previous value on drop. Leaking an amuxd home that
        // points at a deleted tempdir breaks whichever unrelated test runs
        // next — it cost the pi catalog-probe test one red run to find that.
        let home = tempfile::tempdir().unwrap();
        let _env = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());

        let team_id = "team-mcp-inventory";
        std::fs::create_dir_all(home.path()).unwrap();
        std::fs::write(
            crate::config::device_mcp::device_mcp_file(),
            r#"{"mcp":{"playwright":{"type":"local","command":["npx","@playwright/mcp"]}}}"#,
        )
        .unwrap();

        let workspace = crate::config::global_team_store::default_workspace_dir(team_id);
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            workspace.join("opencode.json"),
            r#"{"mcp":{"my-own":{"type":"local","command":["node","server.js"]}}}"#,
        )
        .unwrap();

        let items = mcp_inventory(team_id);
        let by_name: std::collections::HashMap<_, _> =
            items.iter().map(|i| (i.name.as_str(), i)).collect();

        let playwright = by_name
            .get("playwright")
            .expect("device server must reach the inventory");
        assert_eq!(playwright.source, "builtin");
        // `ensure_device_mcp` rewrites this file and the RPC has no update
        // action for it, so offering it as editable would be a lie.
        assert!(playwright.read_only);

        let own = by_name
            .get("my-own")
            .expect("workspace server must reach the inventory");
        assert_eq!(own.source, "personal");
        assert!(!own.read_only);
    }
}
