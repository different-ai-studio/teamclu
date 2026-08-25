//! What the pipeline guarantees, pinned with a fake driver rather than a live
//! bot. Every assertion here corresponds to something that is currently true on
//! exactly one channel, or true nowhere.

use std::sync::Mutex;

use super::*;
use teamclu_gateway::driver::{
    ChannelCaps, ChannelId, ConversationKind, DriverError, InboundAttachment, Threading,
};

#[derive(Default)]
struct FakeDedup {
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl DedupStore for FakeDedup {
    async fn claim(&self, channel: &str, id: &str) -> bool {
        let key = format!("{channel}:{id}");
        let mut seen = self.seen.lock().unwrap();
        if seen.contains(&key) {
            return false;
        }
        seen.push(key);
        true
    }
}

#[derive(Default)]
struct FakeRouter {
    bindings: Mutex<Vec<String>>,
}

#[async_trait]
impl SessionRouter for FakeRouter {
    async fn resolve(
        &self,
        binding: &str,
        _title: &str,
        _actor: &str,
    ) -> Result<SessionRef, CoreError> {
        self.bindings.lock().unwrap().push(binding.to_string());
        Ok(SessionRef {
            session_id: format!("session-for-{binding}"),
            acp_session_id: format!("acp-for-{binding}"),
        })
    }
}

#[derive(Default)]
struct FakeIdentity {
    urns: Mutex<Vec<String>>,
    joined: Mutex<Vec<(String, String)>>,
}

#[async_trait]
impl IdentityMapper for FakeIdentity {
    async fn actor_for(&self, urn: &str, _display: &str) -> Result<String, CoreError> {
        self.urns.lock().unwrap().push(urn.to_string());
        Ok(format!("actor-for-{urn}"))
    }
    async fn join(&self, session: &str, actor: &str) -> Result<(), CoreError> {
        self.joined
            .lock()
            .unwrap()
            .push((session.to_string(), actor.to_string()));
        Ok(())
    }
}

#[derive(Default)]
struct FakeWriter {
    inbound: Mutex<Vec<(String, String, usize)>>, // (text, actor, attachment count)
    replies: Mutex<Vec<String>>,
    log: Mutex<Vec<&'static str>>,
}

#[async_trait]
impl SessionWriter for FakeWriter {
    async fn write_inbound(
        &self,
        _session: &str,
        actor: &str,
        text: &str,
        attachments: Vec<PendingUpload>,
        _external: &str,
    ) -> Result<String, CoreError> {
        self.log.lock().unwrap().push("write_inbound");
        self.inbound
            .lock()
            .unwrap()
            .push((text.to_string(), actor.to_string(), attachments.len()));
        Ok("msg-in".into())
    }

    async fn write_reply(
        &self,
        _session: &str,
        text: &str,
        _attachments: Vec<SessionAttachment>,
    ) -> Result<String, CoreError> {
        self.log.lock().unwrap().push("write_reply");
        self.replies.lock().unwrap().push(text.to_string());
        Ok("msg-out".into())
    }

    async fn upload(
        &self,
        _session: &str,
        upload: &PendingUpload,
    ) -> Result<SessionAttachment, CoreError> {
        Ok(SessionAttachment {
            filename: upload.filename.clone(),
            mime: upload.mime.clone(),
            bucket_path: format!("bucket/{}", upload.filename),
            local_path: None,
        })
    }
}

struct FakeTurns {
    reply: &'static str,
    deltas: Vec<&'static str>,
    log: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl TurnRunner for FakeTurns {
    async fn run(
        &self,
        acp: &str,
        sender_display: &str,
        _prompt: &str,
        on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        self.log
            .lock()
            .unwrap()
            .push(format!("turn:{acp}:{sender_display}"));
        if let Some(tx) = on_delta {
            for d in &self.deltas {
                let _ = tx.send(d.to_string()).await;
            }
        }
        Ok(self.reply.to_string())
    }
}

#[derive(Default)]
struct FakeCommands {
    /// Commands this fake claims to handle, with their canned reply.
    handled: Vec<(&'static str, &'static str)>,
    seen: Mutex<Vec<(String, String)>>, // (name, acp session)
}

#[async_trait]
impl CommandRunner for FakeCommands {
    async fn dispatch(
        &self,
        name: &str,
        _arg: Option<&str>,
        acp: &str,
    ) -> Result<Option<String>, CoreError> {
        self.seen
            .lock()
            .unwrap()
            .push((name.to_string(), acp.to_string()));
        Ok(self
            .handled
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, r)| r.to_string()))
    }
    fn needs_session(&self, name: &str) -> bool {
        name != "help"
    }
    fn unknown_command_text(&self, name: &str) -> String {
        format!("unknown: /{name}")
    }
}

#[derive(Default)]
struct FakeDriver {
    caps: Option<ChannelCaps>,
    delivered: Mutex<Vec<(String, Option<String>)>>, // (text, reply_context)
    updates: Mutex<Vec<(String, bool)>>,
    /// How each update reported the turn's state — `None` while streaming.
    ends: Mutex<Vec<Option<TurnEnd>>>,
}

#[async_trait]
impl ChannelDriver for FakeDriver {
    fn id(&self) -> ChannelId {
        "wecom"
    }
    fn caps(&self) -> ChannelCaps {
        self.caps.unwrap_or(IM)
    }
    fn binding(&self, c: &Conversation) -> String {
        format!(
            "wecom://{}/{}/{}",
            c.bot_id.as_deref().unwrap_or("nobot"),
            match c.kind {
                ConversationKind::Group => "group",
                _ => "single",
            },
            c.id
        )
    }
    fn sender_urn(&self, _c: &Conversation, s: &ExternalSender) -> String {
        format!("urn:wecom:user:{}", s.external_id)
    }
    fn session_title(&self, c: &Conversation, _s: &ExternalSender) -> String {
        format!("WeCom: {}", c.id)
    }
    async fn deliver(
        &self,
        _to: &Conversation,
        reply_context: Option<&str>,
        msg: &OutboundMessage,
    ) -> Result<DeliveryId, DriverError> {
        self.delivered
            .lock()
            .unwrap()
            .push((msg.text.clone(), reply_context.map(|s| s.to_string())));
        Ok(DeliveryId("d-1".into()))
    }
    async fn update(
        &self,
        _id: &DeliveryId,
        text: &str,
        end: Option<TurnEnd>,
    ) -> Result<(), DriverError> {
        self.updates
            .lock()
            .unwrap()
            .push((text.to_string(), end.is_some()));
        self.ends.lock().unwrap().push(end);
        Ok(())
    }
}

const IM: ChannelCaps = ChannelCaps {
    streaming_edit: true,
    media_upload: true,
    interactive: true,
    threading: Threading::Inline,
    max_chars: 2048,
    turn_timeout_secs: 180,
};

const MAIL: ChannelCaps = ChannelCaps {
    streaming_edit: false,
    media_upload: true,
    interactive: false,
    threading: Threading::MailHeaders,
    max_chars: 100_000,
    // A mail round trip is minutes, not the IM-shaped 180s in session_queue.rs.
    turn_timeout_secs: 900,
};

struct Fixture {
    core: Core,
    writer: Arc<FakeWriter>,
    identity: Arc<FakeIdentity>,
    router: Arc<FakeRouter>,
    commands: Arc<FakeCommands>,
    turn_log: Arc<Mutex<Vec<String>>>,
}

fn fixture(reply: &'static str, deltas: Vec<&'static str>, commands: FakeCommands) -> Fixture {
    let writer = Arc::new(FakeWriter::default());
    let identity = Arc::new(FakeIdentity::default());
    let router = Arc::new(FakeRouter::default());
    let commands = Arc::new(commands);
    let turn_log = Arc::new(Mutex::new(Vec::new()));
    Fixture {
        core: Core {
            dedup: Arc::new(FakeDedup::default()),
            router: router.clone(),
            identity: identity.clone(),
            writer: writer.clone(),
            turns: Arc::new(FakeTurns {
                reply,
                deltas,
                log: turn_log.clone(),
            }),
            commands: commands.clone(),
        },
        writer,
        identity,
        router,
        commands,
        turn_log,
    }
}

fn plain(reply: &'static str) -> Fixture {
    fixture(reply, vec![], FakeCommands::default())
}

fn inbound(text: &str) -> InboundMessage {
    InboundMessage {
        conversation: Conversation {
            channel: "wecom",
            bot_id: Some("bot-a".into()),
            kind: ConversationKind::Direct,
            id: "u-1".into(),
        },
        sender: ExternalSender {
            external_id: "u-1".into(),
            display_name: String::new(),
            email: None,
        },
        external_message_id: "m-1".into(),
        text: text.into(),
        attachments: Vec::new(),
        addressed_to_bot: true,
        quoted_text: None,
        reply_context: Some("req-1".into()),
    }
}

/// `inbound` for a specific chat, so a test can own its session id.
fn inbound_from(chat: &str, text: &str) -> InboundMessage {
    let mut msg = inbound(text);
    msg.conversation.id = chat.to_string();
    msg.sender.external_id = chat.to_string();
    msg
}

fn driver(caps: ChannelCaps) -> FakeDriver {
    FakeDriver {
        caps: Some(caps),
        ..Default::default()
    }
}

#[tokio::test]
async fn the_inbound_message_is_written_before_the_turn_runs() {
    // The symptom this prevents: a three-minute turn during which the user's
    // own message exists nowhere, then both rows land 39ms apart.
    let f = plain("done");
    let d = driver(MAIL);
    f.core.handle(&d, inbound("hi")).await.unwrap();

    let writes = f.writer.log.lock().unwrap().clone();
    assert_eq!(writes, vec!["write_inbound", "write_reply"]);
    assert_eq!(f.turn_log.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_redelivered_message_produces_no_second_turn() {
    let f = plain("done");
    let d = driver(IM);
    let first = f.core.handle(&d, inbound("hi")).await.unwrap();
    let second = f.core.handle(&d, inbound("hi")).await.unwrap();

    assert!(matches!(first, Outcome::Handled { .. }));
    assert_eq!(second, Outcome::Duplicate);
    assert_eq!(f.turn_log.lock().unwrap().len(), 1, "exactly one turn");
}

#[tokio::test]
async fn a_group_message_that_does_not_address_the_bot_is_ignored() {
    let f = plain("done");
    let d = driver(IM);
    let mut msg = inbound("chatter between humans");
    msg.conversation.kind = ConversationKind::Group;
    msg.addressed_to_bot = false;

    assert_eq!(f.core.handle(&d, msg).await.unwrap(), Outcome::NotAddressed);
    assert!(f.turn_log.lock().unwrap().is_empty(), "no turn, no write");
    assert!(f.writer.log.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_bare_mention_says_nothing_and_starts_nothing() {
    let f = plain("done");
    let d = driver(IM);
    assert_eq!(
        f.core.handle(&d, inbound("   ")).await.unwrap(),
        Outcome::Empty
    );
}

#[tokio::test]
async fn a_channel_that_cannot_edit_gets_exactly_one_delivery() {
    // Email. The turn still streams internally — the session and the desktop
    // see deltas — the channel just receives the finished text once.
    let f = fixture(
        "the whole answer",
        vec!["the", "the whole"],
        FakeCommands::default(),
    );
    let d = driver(MAIL);

    let outcome = f.core.handle(&d, inbound("hi")).await.unwrap();
    assert!(matches!(outcome, Outcome::Handled { deliveries: 1, .. }));
    let delivered = d.delivered.lock().unwrap();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].0, "the whole answer");
    assert!(d.updates.lock().unwrap().is_empty(), "nothing to edit");
}

#[tokio::test]
async fn a_turn_that_produced_nothing_closes_as_cancelled_and_writes_no_message() {
    // `/stop` ends the turn with no text. Closing the bubble on "answered"
    // told the user the thing they had just cancelled finished anyway, and
    // writing the empty reply made the store reject it ("content is
    // required") — an error log for a turn that did exactly as asked.
    let f = fixture("", vec![], FakeCommands::default());
    let d = driver(IM);

    f.core.handle(&d, inbound("top10 体育新闻")).await.unwrap();

    let ends = d.ends.lock().unwrap();
    assert_eq!(
        ends.last().copied().flatten(),
        Some(TurnEnd::NoAnswer),
        "a cancelled turn must not close as answered"
    );
    assert!(
        f.writer.replies.lock().unwrap().is_empty(),
        "nothing was said, so nothing belongs in the session"
    );
}

#[tokio::test]
async fn a_channel_that_can_edit_sees_every_delta_and_a_final_edit() {
    let f = fixture(
        "Hello world",
        vec!["He", "Hello", "Hello wo"],
        FakeCommands::default(),
    );
    let d = driver(IM);

    f.core.handle(&d, inbound("hi")).await.unwrap();

    let updates = d.updates.lock().unwrap();
    assert_eq!(updates.len(), 4, "3 deltas + the final");
    assert_eq!(updates.last().unwrap().0, "Hello world");
    assert!(updates.last().unwrap().1, "the last edit is marked final");
    // The opening delivery is what the streaming edits then replace.
    assert_eq!(d.delivered.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_reply_context_travels_back_to_the_driver_untouched() {
    // WeCom's reply path is bound to the websocket request that delivered the
    // message. Losing this means the reply has nowhere to go.
    let f = plain("done");
    let d = driver(MAIL);
    f.core.handle(&d, inbound("hi")).await.unwrap();
    assert_eq!(d.delivered.lock().unwrap()[0].1.as_deref(), Some("req-1"));
}

#[tokio::test]
async fn two_bots_in_one_chat_resolve_to_different_sessions() {
    let f = plain("done");
    let d = driver(IM);

    let mut a = inbound("hi");
    a.conversation.kind = ConversationKind::Group;
    a.conversation.id = "chat-1".into();
    let mut b = inbound("hi");
    b.conversation.kind = ConversationKind::Group;
    b.conversation.id = "chat-1".into();
    b.conversation.bot_id = Some("bot-b".into());
    b.external_message_id = "m-2".into();

    f.core.handle(&d, a).await.unwrap();
    f.core.handle(&d, b).await.unwrap();

    let bindings = f.router.bindings.lock().unwrap();
    assert_ne!(bindings[0], bindings[1]);
}

#[tokio::test]
async fn quoted_context_is_prepended_once_for_every_channel() {
    let f = plain("done");
    let d = driver(MAIL);
    let mut msg = inbound("yes");
    msg.quoted_text = Some("pick one: a or b".into());

    f.core.handle(&d, msg).await.unwrap();

    let written = f.writer.inbound.lock().unwrap();
    assert!(written[0].0.contains("[Quoted message]"));
    assert!(written[0].0.ends_with("yes"));
}

#[tokio::test]
async fn attachments_are_resolved_and_written_with_the_message() {
    // Inbound attachments exist on WeCom today and nowhere else. Here they are
    // a property of the pipeline, so a channel gets them by having them.
    let f = plain("done");
    let d = driver(MAIL);
    let mut msg = inbound("see attached");
    msg.attachments.push(InboundAttachment {
        filename: "report.pdf".into(),
        mime: "application/pdf".into(),
        size_hint: Some(3),
        source: AttachmentSource::Ready(vec![1, 2, 3]),
    });

    f.core.handle(&d, msg).await.unwrap();
    assert_eq!(f.writer.inbound.lock().unwrap()[0].2, 1);
}

/// A turn that attaches a file part-way through, the way `send` does.
struct AttachingTurns {
    session_id: String,
    filename: &'static str,
    reply: &'static str,
}

#[async_trait]
impl TurnRunner for AttachingTurns {
    async fn run(
        &self,
        _acp: &str,
        _display: &str,
        _prompt: &str,
        _on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        let attached = super::turn_attachments::attach(
            &self.session_id,
            SessionAttachment {
                filename: self.filename.into(),
                mime: "text/markdown".into(),
                bucket_path: format!("bucket/{}", self.filename),
                local_path: Some(format!("/tmp/{}", self.filename)),
            },
        );
        assert!(attached, "the window must be open while the turn runs");
        Ok(self.reply.to_string())
    }
}

fn attaching_fixture(
    chat: &'static str,
    filename: &'static str,
    reply: &'static str,
) -> (Core, Arc<FakeWriter>) {
    let writer = Arc::new(FakeWriter::default());
    (
        Core {
            dedup: Arc::new(FakeDedup::default()),
            router: Arc::new(FakeRouter::default()),
            identity: Arc::new(FakeIdentity::default()),
            writer: writer.clone(),
            turns: Arc::new(AttachingTurns {
                // Matches what FakeRouter builds for `inbound_from(chat)`.
                // Distinct per test: the registry is process-global, so a
                // shared id would let parallel tests close each other's
                // windows.
                session_id: format!("session-for-wecom://bot-a/single/{chat}"),
                filename,
                reply,
            }),
            commands: Arc::new(FakeCommands::default()),
        },
        writer,
    )
}

#[tokio::test]
async fn a_file_sent_during_the_turn_rides_out_with_the_reply() {
    // The duplicate this removes: `send` used to push the file and record its
    // own message, and then the turn's reply — usually a paragraph describing
    // the file it had just sent — arrived as a second message.
    let (core, writer) = attaching_fixture("u-att-1", "poem.md", "wrote you a poem");
    let d = driver(MAIL);

    core.handle(&d, inbound_from("u-att-1", "write me a poem"))
        .await
        .unwrap();

    let delivered = d.delivered.lock().unwrap();
    assert_eq!(delivered.len(), 1, "one message, not one per file");
    // And exactly one row in the session, carrying both.
    assert_eq!(writer.replies.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_channel_that_cannot_upload_still_names_the_file() {
    // Feishu today. Dropping the attachment silently is what happens now; the
    // reader has to at least learn that a file exists.
    let (core, _w) = attaching_fixture("u-att-2", "poem.md", "wrote you a poem");
    let no_media = ChannelCaps {
        media_upload: false,
        ..MAIL
    };
    let d = driver(no_media);

    core.handle(&d, inbound_from("u-att-2", "write me a poem"))
        .await
        .unwrap();

    let delivered = d.delivered.lock().unwrap();
    assert!(
        delivered[0].0.contains("poem.md"),
        "got: {}",
        delivered[0].0
    );
}

#[tokio::test]
async fn the_attachment_window_is_closed_after_the_turn() {
    // Left open, the next `send` on this session would attach to a reply that
    // has already gone out, and the file would never appear anywhere.
    let (core, _w) = attaching_fixture("u-att-3", "poem.md", "done");
    let d = driver(MAIL);
    core.handle(&d, inbound_from("u-att-3", "write me a poem"))
        .await
        .unwrap();

    assert!(!super::turn_attachments::is_open(
        "session-for-wecom://bot-a/single/u-att-3"
    ));
}

#[tokio::test]
async fn the_sender_is_the_human_and_falls_back_to_their_id() {
    // WeCom callbacks carry no display name; "" would reach the agent as an
    // anonymous speaker.
    let f = plain("done");
    let d = driver(MAIL);
    f.core.handle(&d, inbound("hi")).await.unwrap();

    assert_eq!(f.identity.urns.lock().unwrap()[0], "urn:wecom:user:u-1");
    assert_eq!(
        f.writer.inbound.lock().unwrap()[0].1,
        "actor-for-urn:wecom:user:u-1"
    );
    assert!(
        f.turn_log.lock().unwrap()[0].ends_with(":u-1"),
        "display falls back to the id"
    );
}

#[tokio::test]
async fn a_help_command_is_answered_without_creating_a_session() {
    // Asking for help in a chat the bot has never seen must not leave a
    // session behind as a side effect.
    let f = fixture(
        "unused",
        vec![],
        FakeCommands {
            handled: vec![("help", "here is help")],
            ..Default::default()
        },
    );
    let d = driver(IM);

    let outcome = f.core.handle(&d, inbound("/help")).await.unwrap();

    assert_eq!(outcome, Outcome::Command { handled: true });
    assert!(
        f.router.bindings.lock().unwrap().is_empty(),
        "no session made"
    );
    assert!(f.turn_log.lock().unwrap().is_empty(), "no turn run");
    assert_eq!(d.delivered.lock().unwrap()[0].0, "here is help");
}

#[tokio::test]
async fn a_session_command_runs_against_the_resolved_session() {
    let f = fixture(
        "unused",
        vec![],
        FakeCommands {
            handled: vec![("compact", "compacted")],
            ..Default::default()
        },
    );
    let d = driver(IM);

    let outcome = f.core.handle(&d, inbound("/compact")).await.unwrap();

    assert_eq!(outcome, Outcome::Command { handled: true });
    let seen = f.commands.seen.lock().unwrap();
    assert_eq!(seen[0].0, "compact");
    assert!(seen[0].1.starts_with("acp-for-"), "got a real session id");
    assert!(
        f.turn_log.lock().unwrap().is_empty(),
        "a command is not a turn"
    );
}

#[tokio::test]
async fn an_unknown_command_says_so_instead_of_starting_a_turn() {
    let f = plain("unused");
    let d = driver(IM);

    let outcome = f.core.handle(&d, inbound("/nonsense")).await.unwrap();

    assert_eq!(outcome, Outcome::Command { handled: false });
    assert_eq!(d.delivered.lock().unwrap()[0].0, "unknown: /nonsense");
    assert!(f.turn_log.lock().unwrap().is_empty());
}

#[cfg(test)]
mod object_key_tests {
    use crate::channels::core::safe_object_name;

    #[test]
    fn a_non_ascii_name_survives_as_a_usable_key() {
        // The store rejects non-ASCII keys outright: `诗一首.md` came back
        // `validation_failed: Invalid key`, so the chat got the file and the
        // session copy had no download.
        assert_eq!(safe_object_name("诗一首.md"), "file.md");
        assert_eq!(safe_object_name("报告 final.pdf"), "final.pdf");
    }

    #[test]
    fn an_ascii_name_is_left_alone() {
        assert_eq!(safe_object_name("report-v2.pdf"), "report-v2.pdf");
        assert_eq!(safe_object_name("a_b.c-d.txt"), "a_b.c-d.txt");
    }

    #[test]
    fn a_name_with_nothing_usable_still_yields_a_key() {
        // Never empty: an empty segment would make the key end in `-`.
        assert!(!safe_object_name("中文").is_empty());
        assert!(!safe_object_name("...").is_empty());
        assert_eq!(safe_object_name("中文"), "file");
    }
}
