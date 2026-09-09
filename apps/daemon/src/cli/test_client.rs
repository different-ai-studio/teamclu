use prost::Message;
use rumqttc::{AsyncClient, Event, EventLoop, MqttOptions, Packet, QoS, Transport};
use std::sync::Arc;
use teamclu_types::mqtt::MQTT_FALLBACK_TEAM_ID;
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::DaemonConfig;
use crate::mqtt::Topics;
use crate::proto::amux;

struct TestClient {
    client: AsyncClient,
    eventloop: EventLoop,
    topics: Topics,
    peer_id: String,
    config: DaemonConfig,
}

impl TestClient {
    fn new(config: DaemonConfig) -> crate::error::Result<Self> {
        let peer_id = format!("test-client-{}", &Uuid::new_v4().to_string()[..6]);
        let client_id = format!("amux-test-{}", &peer_id);

        let host = config
            .mqtt
            .broker_url
            .trim_start_matches("mqtts://")
            .trim_start_matches("mqtt://");
        let use_tls = config.mqtt.broker_url.starts_with("mqtts://");

        let mut opts = MqttOptions::new(&client_id, host, 8883);
        opts.set_credentials("test-client", "");
        opts.set_keep_alive(std::time::Duration::from_secs(30));
        opts.set_clean_session(true);

        if use_tls {
            let mut tls_config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(
                    crate::mqtt::client_danger::NoCertVerifier,
                ))
                .with_no_client_auth();
            tls_config.alpn_protocols = vec![];
            opts.set_transport(Transport::tls_with_config(
                rumqttc::TlsConfiguration::Rustls(Arc::new(tls_config)),
            ));
        }

        let team_id = config.team_id.as_deref().unwrap_or(MQTT_FALLBACK_TEAM_ID);
        let topics = Topics::new(team_id, &config.actor.id);
        let (client, eventloop) = AsyncClient::new(opts, 100);

        Ok(Self {
            client,
            eventloop,
            topics,
            peer_id,
            config,
        })
    }

    async fn subscribe_all(&self) -> Result<(), rumqttc::ClientError> {
        let actor_id = &self.config.actor.id;

        // Subscribe to current topics only. Legacy /status, /peers, /members,
        // /collab, and agent/+/... wildcards were retired in Phase 3.
        self.client
            .subscribe(self.topics.actor_state(), QoS::AtLeastOnce)
            .await?;
        self.client
            .subscribe(self.topics.runtime_state_wildcard(), QoS::AtLeastOnce)
            .await?;
        let team_id = self
            .config
            .team_id
            .as_deref()
            .unwrap_or(MQTT_FALLBACK_TEAM_ID);
        self.client
            .subscribe(
                &format!("amux/{}/{}/runtime/+/events", team_id, actor_id),
                QoS::AtLeastOnce,
            )
            .await?;

        info!("subscribed to all amux/{}/... topics", actor_id);
        Ok(())
    }
}

pub async fn run_watch(config: DaemonConfig) -> anyhow::Result<()> {
    let mut tc = TestClient::new(config)?;
    tc.subscribe_all().await?;

    println!(
        "📡 Watching MQTT topics for actor {}...\n",
        tc.config.actor.id
    );

    loop {
        match tc.eventloop.poll().await {
            Ok(Event::Incoming(Packet::Publish(publish))) => {
                let topic = &publish.topic;
                let payload = &publish.payload;
                let retained = if publish.retain { " [retained]" } else { "" };

                // Try to decode based on topic. Only current topics are live:
                //   {actor}/state          — ActorPresence (retained LWT)
                //   {actor}/runtime/{rid}/state   — RuntimeInfo (retained)
                //   {actor}/runtime/{rid}/events  — Envelope stream
                if topic.ends_with("/events") {
                    match amux::Envelope::decode(payload.as_ref()) {
                        Ok(env) => {
                            let agent_id = &env.runtime_id;
                            let seq = env.sequence;
                            match &env.payload {
                                Some(amux::envelope::Payload::AcpEvent(acp)) => match &acp.event {
                                    Some(amux::acp_event::Event::Output(o)) => {
                                        let text = if o.text.len() > 120 {
                                            format!("{}...", &o.text[..120])
                                        } else {
                                            o.text.clone()
                                        };
                                        println!("💬 [{}] seq={} Output: {}", agent_id, seq, text);
                                    }
                                    Some(amux::acp_event::Event::Thinking(t)) => {
                                        let text = if t.text.len() > 80 {
                                            format!("{}...", &t.text[..80])
                                        } else {
                                            t.text.clone()
                                        };
                                        println!(
                                            "🧠 [{}] seq={} Thinking: {}",
                                            agent_id, seq, text
                                        );
                                    }
                                    Some(amux::acp_event::Event::ToolUse(tu)) => {
                                        println!(
                                            "🔧 [{}] seq={} ToolUse: {} ({})",
                                            agent_id, seq, tu.tool_name, tu.tool_id
                                        );
                                    }
                                    Some(amux::acp_event::Event::ToolResult(tr)) => {
                                        println!(
                                            "✅ [{}] seq={} ToolResult: success={}",
                                            agent_id, seq, tr.success
                                        );
                                    }
                                    Some(amux::acp_event::Event::StatusChange(sc)) => {
                                        println!(
                                            "🔄 [{}] seq={} Status: {:?} → {:?}",
                                            agent_id,
                                            seq,
                                            amux::AgentStatus::try_from(sc.old_status)
                                                .unwrap_or(amux::AgentStatus::Unknown),
                                            amux::AgentStatus::try_from(sc.new_status)
                                                .unwrap_or(amux::AgentStatus::Unknown)
                                        );
                                    }
                                    Some(amux::acp_event::Event::Error(e)) => {
                                        println!(
                                            "❌ [{}] seq={} Error: {}",
                                            agent_id, seq, e.message
                                        );
                                    }
                                    Some(amux::acp_event::Event::PermissionRequest(pr)) => {
                                        println!(
                                            "🔐 [{}] seq={} PermissionRequest: {} ({})",
                                            agent_id, seq, pr.tool_name, pr.request_id
                                        );
                                    }
                                    _ => println!("📨 [{}] seq={} AcpEvent (other)", agent_id, seq),
                                },
                                Some(amux::envelope::Payload::SessionEvent(ce)) => {
                                    match &ce.event {
                                        Some(amux::session_event::Event::PromptAccepted(pa)) => {
                                            println!(
                                                "✅ [{}] PromptAccepted cmd={}",
                                                agent_id, pa.command_id
                                            );
                                        }
                                        Some(amux::session_event::Event::PromptRejected(pr)) => {
                                            println!(
                                                "❌ [{}] PromptRejected cmd={} reason={}",
                                                agent_id, pr.command_id, pr.reason
                                            );
                                        }
                                        Some(amux::session_event::Event::PermissionResolved(
                                            pr,
                                        )) => {
                                            println!(
                                                "🔐 [{}] PermissionResolved req={} granted={}",
                                                agent_id, pr.request_id, pr.granted
                                            );
                                        }
                                        _ => println!("📨 [{}] CollabEvent (other)", agent_id),
                                    }
                                }
                                None => println!("📨 [{}] seq={} Empty envelope", agent_id, seq),
                            }
                        }
                        Err(e) => {
                            println!("❓ {} → {} bytes (decode: {})", topic, payload.len(), e)
                        }
                    }
                } else if topic.ends_with("/state") {
                    // Either {actor}/state (ActorPresence) or runtime/{rid}/state (RuntimeInfo).
                    if let Ok(info) = amux::RuntimeInfo::decode(payload.as_ref()) {
                        println!(
                            "📊 {} → RuntimeInfo {{ id={}, status={:?}, worktree=\"{}\" }}{}",
                            topic,
                            info.runtime_id,
                            amux::AgentStatus::try_from(info.status)
                                .unwrap_or(amux::AgentStatus::Unknown),
                            info.worktree,
                            retained
                        );
                    } else if let Ok(s) = amux::ActorPresence::decode(payload.as_ref()) {
                        println!(
                            "📌 {} → ActorPresence {{ online: {}, name: \"{}\" }}{}",
                            topic, s.online, s.display_name, retained
                        );
                    } else {
                        println!(
                            "❓ {} → {} bytes (decode failed){}",
                            topic,
                            payload.len(),
                            retained
                        );
                    }
                } else {
                    println!("❓ {} → {} bytes{}", topic, payload.len(), retained);
                }
            }
            Ok(_) => {}
            Err(e) => {
                warn!("MQTT error: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}

pub async fn run_start_agent(
    config: DaemonConfig,
    worktree: &str,
    prompt: &str,
) -> anyhow::Result<()> {
    let tc = TestClient::new(config)?;

    // Need to pump eventloop once to connect
    let connect_task = tokio::spawn({
        let mut el = tc.eventloop;
        async move {
            // Pump a few events to establish connection
            for _ in 0..5 {
                match tokio::time::timeout(std::time::Duration::from_secs(2), el.poll()).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => warn!("mqtt: {}", e),
                    Err(_) => break,
                }
            }
        }
    });

    // Give connection time to establish
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let envelope = amux::RuntimeCommandEnvelope {
        runtime_id: String::new(), // daemon will assign
        actor_id: tc.config.actor.id.clone(),
        peer_id: tc.peer_id.clone(),
        command_id: Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().timestamp(),
        sender_actor_id: String::new(),
        reply_to_actor_id: tc.config.actor.id.clone(),
        acp_command: Some(amux::AcpCommand {
            command: Some(amux::acp_command::Command::StartAgent(
                amux::AcpStartAgent {
                    agent_type: amux::AgentType::ClaudeCode as i32,
                    worktree: worktree.into(),
                    initial_prompt: prompt.into(),
                    workspace_id: String::new(),
                    session_id: String::new(),
                },
            )),
        }),
    };

    let payload = envelope.encode_to_vec();
    // Send to a dummy agent ID — daemon picks up from wildcard subscription
    let topic = tc.topics.runtime_commands("new");

    tc.client
        .publish(&topic, QoS::AtLeastOnce, false, payload)
        .await?;
    println!(
        "📤 Sent StartAgent command (worktree={}, prompt=\"{}\")",
        worktree, prompt
    );
    println!("   to topic: {}", topic);
    println!(
        "\n   Now run `amuxd test-client --config <path> watch` in another terminal to see events."
    );

    // Give time for the publish to go through
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let _ = connect_task.await;

    Ok(())
}

pub async fn run_announce(_config: DaemonConfig, _token: &str) -> anyhow::Result<()> {
    // The legacy /collab PeerAnnounce flow was retired in Phase 3 — the daemon
    // no longer subscribes to `{actor}/collab`. Use the RPC equivalent
    // (`AuthenticatePeer` on `{actor}/rpc/req`) from iOS instead.
    println!("⚠️  `test-client announce` is deprecated: daemon no longer subscribes to {{actor}}/collab.");
    println!("    Use the RPC-based authentication flow from the iOS client.");
    Ok(())
}

/// Full E2E: single connection that subscribes to retained state, starts an agent, and watches events.
pub async fn run_e2e(
    config: DaemonConfig,
    _token: &str,
    worktree: &str,
    prompt: &str,
) -> anyhow::Result<()> {
    let mut tc = TestClient::new(config)?;
    tc.subscribe_all().await?;

    let peer_id = tc.peer_id.clone();
    let actor_id = tc.config.actor.id.clone();

    println!("🚀 E2E test (peer_id={}, actor={})\n", peer_id, actor_id);
    println!("⚠️  Legacy PeerAnnounce step skipped: daemon no longer accepts /collab.");
    println!("    This run assumes broker-level JWT auth is already established.\n");

    // Phase 1: connect + receive retained
    println!("--- Phase 1: Connect & receive retained state ---");
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(3);
    loop {
        match tokio::time::timeout_at(deadline, tc.eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Packet::Publish(p)))) => print_publish(&p),
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                warn!("mqtt: {}", e);
                break;
            }
            Err(_) => break,
        }
    }

    // Phase 2: StartAgent
    println!("\n--- Phase 2: Start Agent ---");
    let start_cmd = amux::RuntimeCommandEnvelope {
        runtime_id: String::new(),
        actor_id: actor_id.clone(),
        peer_id: peer_id.clone(),
        command_id: Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().timestamp(),
        sender_actor_id: String::new(),
        reply_to_actor_id: actor_id.clone(),
        acp_command: Some(amux::AcpCommand {
            command: Some(amux::acp_command::Command::StartAgent(
                amux::AcpStartAgent {
                    agent_type: amux::AgentType::ClaudeCode as i32,
                    worktree: worktree.into(),
                    initial_prompt: prompt.into(),
                    workspace_id: String::new(),
                    session_id: String::new(),
                },
            )),
        }),
    };
    let topic = tc.topics.runtime_commands("new");
    tc.client
        .publish(&topic, QoS::AtLeastOnce, false, start_cmd.encode_to_vec())
        .await?;
    println!("📤 StartAgent sent (prompt=\"{}\")", prompt);

    // Phase 3: Watch events
    println!("\n--- Phase 3: Watching agent events ---");
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(60);
    let mut event_count = 0u32;
    loop {
        match tokio::time::timeout_at(deadline, tc.eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Packet::Publish(p)))) => {
                print_publish(&p);
                event_count += 1;
                // Check for agent completion
                if p.topic.ends_with("/events") {
                    if let Ok(env) = amux::Envelope::decode(p.payload.as_ref()) {
                        if let Some(amux::envelope::Payload::AcpEvent(ref acp)) = env.payload {
                            if let Some(amux::acp_event::Event::StatusChange(ref sc)) = acp.event {
                                if sc.new_status == amux::AgentStatus::Idle as i32 {
                                    println!("\n✅ Agent completed. {} events total.", event_count);
                                    // Drain 3 more seconds
                                    let drain = tokio::time::Instant::now()
                                        + tokio::time::Duration::from_secs(3);
                                    loop {
                                        match tokio::time::timeout_at(drain, tc.eventloop.poll())
                                            .await
                                        {
                                            Ok(Ok(Event::Incoming(Packet::Publish(p2)))) => {
                                                print_publish(&p2)
                                            }
                                            Ok(Ok(_)) => {}
                                            _ => break,
                                        }
                                    }
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                warn!("mqtt error: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(_) => {
                println!("\n⏱  Timeout. {} events.", event_count);
                break;
            }
        }
    }
    Ok(())
}

fn print_publish(publish: &rumqttc::Publish) {
    let topic = &publish.topic;
    let payload = &publish.payload;
    let retained = if publish.retain { " [retained]" } else { "" };

    if topic.ends_with("/events") {
        if let Ok(env) = amux::Envelope::decode(payload.as_ref()) {
            let id = &env.runtime_id;
            let seq = env.sequence;
            match &env.payload {
                Some(amux::envelope::Payload::AcpEvent(acp)) => match &acp.event {
                    Some(amux::acp_event::Event::Output(o)) => print!("{}", o.text),
                    Some(amux::acp_event::Event::Thinking(t)) => {
                        let s = if t.text.len() > 80 {
                            format!("{}...", &t.text[..80])
                        } else {
                            t.text.clone()
                        };
                        println!("🧠 [{}] Thinking: {}", id, s);
                    }
                    Some(amux::acp_event::Event::ToolUse(tu)) => {
                        println!("🔧 [{}] ToolUse: {}", id, tu.tool_name)
                    }
                    Some(amux::acp_event::Event::ToolResult(tr)) => {
                        println!("✅ [{}] ToolResult: success={}", id, tr.success)
                    }
                    Some(amux::acp_event::Event::StatusChange(sc)) => println!(
                        "🔄 [{}] seq={} {:?} → {:?}",
                        id,
                        seq,
                        amux::AgentStatus::try_from(sc.old_status)
                            .unwrap_or(amux::AgentStatus::Unknown),
                        amux::AgentStatus::try_from(sc.new_status)
                            .unwrap_or(amux::AgentStatus::Unknown)
                    ),
                    Some(amux::acp_event::Event::Error(e)) => {
                        println!("❌ [{}] Error: {}", id, e.message)
                    }
                    _ => println!("📨 [{}] seq={} AcpEvent", id, seq),
                },
                Some(amux::envelope::Payload::SessionEvent(ce)) => match &ce.event {
                    Some(amux::session_event::Event::PromptAccepted(pa)) => {
                        println!("✅ PromptAccepted cmd={}", pa.command_id)
                    }
                    Some(amux::session_event::Event::PromptRejected(pr)) => {
                        println!("❌ PromptRejected: {}", pr.reason)
                    }
                    _ => println!("📨 CollabEvent"),
                },
                None => {}
            }
        }
    } else if topic.ends_with("/state") {
        if let Ok(info) = amux::RuntimeInfo::decode(payload.as_ref()) {
            println!(
                "📊 RuntimeState id={} status={:?}{}",
                info.runtime_id,
                amux::AgentStatus::try_from(info.status).unwrap_or(amux::AgentStatus::Unknown),
                retained
            );
        } else if let Ok(s) = amux::ActorPresence::decode(payload.as_ref()) {
            println!(
                "📌 ActorPresence {{ online: {}, name: \"{}\" }}{}",
                s.online, s.display_name, retained
            );
        }
    }
}
