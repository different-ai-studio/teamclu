//! Push shapes below are real sync-message callbacks from the 8.0.74 server,
//! with wxids and text replaced.

use super::*;

const BOT: &str = "wxid_bot";
const ME: &str = "wxid_me";
const GROUP: &str = "12345@chatroom";

fn push(add_msgs: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "Code": 0, "Success": true, "Message": "", "ID": 0, "Data62": "", "Debug": "",
        "Data": { "AddMsgs": add_msgs, "ContinueFlag": 0, "Status": 0, "Time": 0, "Remarks": "" }
    }))
    .unwrap()
}

fn add_msg(
    id: i64,
    msg_type: i64,
    from: &str,
    to: &str,
    content: &str,
    source: &str,
) -> serde_json::Value {
    serde_json::json!({
        "MsgId": 1, "NewMsgId": id, "MsgType": msg_type,
        "FromUserName": {"string": from}, "ToUserName": {"string": to},
        "Content": {"string": content}, "CreateTime": 1_793_089_524i64,
        "MsgSource": source, "PushContent": "亮亮 : 测试",
        "Status": 3, "ImgStatus": 1, "ImgBuf": {"iLen": 0}, "MsgSeq": 105
    })
}

const PLAIN_SOURCE: &str = "<msgsource>\n\t<alnode>\n\t\t<fr>1</fr>\n\t</alnode>\n</msgsource>\n";

fn cfg() -> WeChatPadConfig {
    WeChatPadConfig {
        enabled: true,
        account_wxid: BOT.into(),
        allow_from: vec![ME.into()],
        ..WeChatPadConfig::default()
    }
}

fn text_msg(text: &str, sender: &str, group: bool, mentions: &[&str], kind: PadKind) -> PadMessage {
    PadMessage {
        new_msg_id: 1,
        chat_id: if group { GROUP.into() } else { sender.into() },
        sender_id: sender.into(),
        is_group: group,
        text: text.into(),
        mentions: mentions.iter().map(|s| s.to_string()).collect(),
        create_time: 0,
        push_content: None,
        kind,
    }
}

// ---------- decoding ----------

#[test]
fn a_private_text_decodes_with_its_id_and_sender() {
    let out = decode_push(&push(serde_json::json!([add_msg(
        4714210626482399224,
        1,
        ME,
        BOT,
        "测试",
        PLAIN_SOURCE
    )])));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].new_msg_id, 4714210626482399224);
    assert_eq!(out[0].chat_id, ME);
    assert_eq!(out[0].sender_id, ME);
    assert!(!out[0].is_group);
    assert_eq!(out[0].text, "测试");
    assert_eq!(out[0].kind, PadKind::Text);
}

#[test]
fn empty_and_idle_pushes_decode_to_nothing() {
    assert!(decode_push(b"").is_empty());
    let idle = r#"{"Code":0,"Success":true,"Message":"当前未有新消息","Data":{"Ret":0,"CmdList":{"Count":0},"ContinueFlag":256,"KeyBuf":{"iLen":0}}}"#;
    assert!(decode_push(idle.as_bytes()).is_empty());
}

#[test]
fn system_messages_are_dropped() {
    let out = decode_push(&push(serde_json::json!([
        add_msg(1, 9999, "weixin", BOT, "x", ""),
        add_msg(2, 10002, "newsapp", BOT, "<sysmsg/>", ""),
        add_msg(3, 51, BOT, BOT, "<msg/>", ""),
    ])));
    assert!(out.is_empty());
}

#[test]
fn a_group_mention_splits_the_sender_off_and_reads_the_at_list() {
    let source = format!("<msgsource>\n\t<atuserlist>{BOT}</atuserlist>\n\t<membercount>5</membercount>\n</msgsource>\n");
    let out = decode_push(&push(serde_json::json!([add_msg(
        7,
        1,
        GROUP,
        BOT,
        &format!("{ME}:\n@亮亮bot\u{2005}你是个机器人吗"),
        &source
    )])));
    assert_eq!(out[0].chat_id, GROUP);
    assert_eq!(out[0].sender_id, ME);
    assert!(out[0].is_group);
    assert_eq!(out[0].text, "@亮亮bot\u{2005}你是个机器人吗");
    assert_eq!(out[0].mentions, vec![BOT.to_string()]);
}

#[test]
fn the_accounts_own_group_message_is_filed_under_the_group() {
    let out = decode_push(&push(serde_json::json!([add_msg(
        9, 1, BOT, GROUP, "hi", ""
    )])));
    assert_eq!(out[0].chat_id, GROUP);
    assert_eq!(out[0].sender_id, BOT);
}

#[test]
fn a_quote_carries_the_reply_text_and_the_quoted_message() {
    let xml = format!(
        "<?xml version=\"1.0\"?>\n<msg>\n\t<appmsg appid=\"\" sdkver=\"0\">\n\t\t<title>继续</title>\n\t\t<type>57</type>\n\
         \t\t<refermsg>\n\t\t\t<type>1</type>\n\t\t\t<svrid>464847956802807278</svrid>\n\t\t\t<fromusr>{BOT}</fromusr>\n\
         \t\t\t<chatusr>{BOT}</chatusr>\n\t\t\t<displayname>bot</displayname>\n\t\t\t<content>跑完了 &amp; 通过</content>\n\
         \t\t</refermsg>\n\t</appmsg>\n\t<fromusername>{ME}</fromusername>\n</msg>"
    );
    let out = decode_push(&push(serde_json::json!([add_msg(
        5, 49, ME, BOT, &xml, ""
    )])));
    assert_eq!(out[0].text, "继续");
    assert_eq!(
        out[0].kind,
        PadKind::Quote {
            quoted_msg_id: Some(464847956802807278),
            quoted_sender: BOT.into(),
            quoted_text: Some("跑完了 & 通过".into()),
        }
    );
}

#[test]
fn a_file_placeholder_is_dropped_and_the_file_kept() {
    let placeholder = "<?xml version=\"1.0\"?>\n<msg><appmsg appid=\"\"><title>a.zip</title><type>74</type></appmsg></msg>";
    let file = "<?xml version=\"1.0\"?>\n<msg><appmsg appid=\"wx6618f1cfc6c132f8\" sdkver=\"0\"><title>a.zip</title><type>6</type>\
                <appattach><totallen>231445</totallen><attachid>@cdn_abc_1</attachid><fileext>zip</fileext></appattach>\
                </appmsg><fromusername>wxid_me</fromusername></msg>";
    let out = decode_push(&push(serde_json::json!([
        add_msg(1, 49, ME, BOT, placeholder, ""),
        add_msg(2, 49, ME, BOT, file, ""),
    ])));
    assert_eq!(out.len(), 1);
    assert_eq!(
        out[0].kind,
        PadKind::File {
            name: "a.zip".into(),
            attach_id: "@cdn_abc_1".into(),
            total_len: 231445,
            app_id: "wx6618f1cfc6c132f8".into(),
            from_user: ME.into(),
        }
    );
}

#[test]
fn leading_mentions_end_at_the_wechat_separator_only() {
    assert_eq!(strip_leading_mentions("@亮亮bot\u{2005}/status"), "/status");
    assert_eq!(strip_leading_mentions("@a\u{2005}@b\u{2005} hi"), "hi");
    assert_eq!(
        strip_leading_mentions("ask @a\u{2005}later"),
        "ask @a\u{2005}later"
    );
    assert_eq!(strip_leading_mentions("@someone hi"), "@someone hi");
}

// ---------- policy ----------

#[test]
fn an_allowed_dm_is_addressed() {
    let got = admit(&cfg(), &text_msg("看下测试", ME, false, &[], PadKind::Text));
    assert_eq!(
        got,
        Some(Admitted {
            text: "看下测试".into(),
            addressed: true
        })
    );
}

#[test]
fn strangers_cannot_dm_the_agent_by_default() {
    assert_eq!(
        admit(
            &cfg(),
            &text_msg("/status", "wxid_other", false, &[], PadKind::Text)
        ),
        None
    );
    let open = WeChatPadConfig {
        dm_policy: "open".into(),
        ..cfg()
    };
    assert!(admit(
        &open,
        &text_msg("hi", "wxid_other", false, &[], PadKind::Text)
    )
    .is_some());
}

#[test]
fn the_accounts_own_messages_never_reach_the_core() {
    let open = WeChatPadConfig {
        dm_policy: "open".into(),
        group_policy: "open".into(),
        ..cfg()
    };
    assert_eq!(
        admit(&open, &text_msg("hi", BOT, false, &[], PadKind::Text)),
        None
    );
    assert_eq!(
        admit(&open, &text_msg("hi", BOT, true, &[], PadKind::Text)),
        None
    );
}

#[test]
fn group_chatter_reaches_the_core_unaddressed() {
    let got = admit(&cfg(), &text_msg("随便聊聊", ME, true, &[], PadKind::Text)).unwrap();
    assert!(!got.addressed);
}

#[test]
fn a_group_is_addressed_by_mention_slash_or_quoting_the_bot() {
    let c = cfg();
    let mentioned = admit(
        &c,
        &text_msg("@亮亮bot\u{2005}/go x", ME, true, &[BOT], PadKind::Text),
    )
    .unwrap();
    assert_eq!(
        mentioned,
        Admitted {
            text: "/go x".into(),
            addressed: true
        }
    );

    assert!(
        admit(&c, &text_msg("/status", ME, true, &[], PadKind::Text))
            .unwrap()
            .addressed
    );

    let quote = |who: &str| PadKind::Quote {
        quoted_msg_id: Some(7),
        quoted_sender: who.into(),
        quoted_text: None,
    };
    assert!(
        admit(&c, &text_msg("继续", ME, true, &[], quote(BOT)))
            .unwrap()
            .addressed
    );
    assert!(
        !admit(&c, &text_msg("继续", ME, true, &[], quote("wxid_z")))
            .unwrap()
            .addressed
    );

    // Mentioning someone else is not addressing the bot.
    assert!(
        !admit(
            &c,
            &text_msg("@张三\u{2005}看下", ME, true, &["wxid_z"], PadKind::Text)
        )
        .unwrap()
        .addressed
    );
}

#[test]
fn group_policy_limits_rooms_and_who_may_trigger() {
    let c = cfg();
    // Everyone in an allowed room is recorded; only the allowlist starts turns.
    assert_eq!(
        admit(
            &c,
            &text_msg(
                "@亮亮bot\u{2005}/status",
                "wxid_other",
                true,
                &[BOT],
                PadKind::Text
            )
        ),
        Some(Admitted {
            text: "/status".into(),
            addressed: false
        })
    );
    let open = WeChatPadConfig {
        group_policy: "open".into(),
        ..cfg()
    };
    assert!(
        admit(
            &open,
            &text_msg(
                "@亮亮bot\u{2005}/status",
                "wxid_other",
                true,
                &[BOT],
                PadKind::Text
            )
        )
        .unwrap()
        .addressed
    );

    let rooms = WeChatPadConfig {
        group_allow_from: vec!["other@chatroom".into()],
        ..cfg()
    };
    assert_eq!(
        admit(&rooms, &text_msg("/status", ME, true, &[], PadKind::Text)),
        None
    );

    let disabled = WeChatPadConfig {
        group_policy: "disabled".into(),
        ..cfg()
    };
    assert_eq!(
        admit(
            &disabled,
            &text_msg("/status", ME, true, &[], PadKind::Text)
        ),
        None
    );
}

#[test]
fn a_bare_mention_is_not_admitted_but_a_bare_image_is() {
    assert_eq!(
        admit(
            &cfg(),
            &text_msg("@亮亮bot\u{2005}", ME, true, &[BOT], PadKind::Text)
        ),
        None
    );
    let image = PadKind::Image {
        aes_key: "k".into(),
        cdn_url: "u".into(),
    };
    // A picture posted in the room is kept, unaddressed, for the next turn.
    assert_eq!(
        admit(
            &cfg(),
            &text_msg("", "wxid_other", true, &[], image.clone())
        ),
        Some(Admitted {
            text: String::new(),
            addressed: false
        })
    );
    let voice = PadKind::Other {
        msg_type: 34,
        app_type: None,
    };
    assert_eq!(admit(&cfg(), &text_msg("", ME, true, &[], voice)), None);
}

#[test]
fn an_image_push_carries_what_its_download_needs() {
    let xml = "<?xml version=\"1.0\"?>\n<msg>\n\t<img aeskey=\"9b70\" encryver=\"1\" cdnthumburl=\"thumb\" \
               cdnmidimgurl=\"mid\" cdnbigimgurl=\"big\" length=\"59896\" md5=\"x\" />\n</msg>\n";
    let out = decode_push(&push(serde_json::json!([add_msg(
        5,
        3,
        GROUP,
        BOT,
        &format!("wxid_other:\n{xml}"),
        ""
    )])));
    assert_eq!(out[0].sender_id, "wxid_other");
    assert_eq!(
        out[0].kind,
        PadKind::Image {
            aes_key: "9b70".into(),
            cdn_url: "big".into()
        }
    );
}

#[tokio::test]
async fn a_file_downloads_section_by_section_from_where_the_bytes_ended() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    // The server hands back 64KB per section whatever length is asked for.
    let file: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
    let served = file.clone();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/Tools/DownloadFile"))
        .respond_with(move |req: &Request| {
            use base64::Engine;
            let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            let start = body["Section"]["StartPos"].as_u64().unwrap() as usize;
            let end = (start + 65536).min(served.len());
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Success": true, "Code": 0,
                "Data": {"data": {"buffer": base64::engine::general_purpose::STANDARD.encode(&served[start..end])}}
            }))
        })
        .mount(&server)
        .await;
    let got = PadApi::new(&server.uri())
        .download_file(BOT, "@cdn", "wx", ME, file.len() as u64)
        .await
        .unwrap();
    assert_eq!(got, file);
}

#[test]
fn normalize_keys_on_new_msg_id_and_names_the_dm_sender() {
    let mut m = text_msg("hi", ME, false, &[], PadKind::Text);
    m.new_msg_id = 42;
    m.push_content = Some("亮亮 : hi".into());
    let n = normalize(
        BOT,
        &m,
        Admitted {
            text: "hi".into(),
            addressed: true,
        },
    );
    assert_eq!(n.external_message_id, "42");
    assert_eq!(n.sender.display_name, "亮亮");
    assert_eq!(n.conversation.kind, ConversationKind::Direct);
    assert_eq!(n.conversation.bot_id.as_deref(), Some(BOT));
    assert!(n.reply_context.is_some());
}

#[test]
fn bindings_separate_dm_and_group() {
    assert_eq!(
        crate::binding::wechatpad_dm(BOT, ME),
        "wechatpad://wxid_bot/single/wxid_me"
    );
    assert_eq!(
        crate::binding::wechatpad_group(BOT, GROUP),
        "wechatpad://wxid_bot/group/12345@chatroom"
    );
}

// ---------- callback HTTP ----------

#[test]
fn the_callback_parser_waits_for_the_whole_body() {
    let head = "POST /api/v1/wechat-client/wxid_bot/sync-message HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\n";
    assert_eq!(
        parse_request(format!("{head}ab").as_bytes()),
        Parsed::Incomplete
    );
    assert_eq!(
        parse_request(format!("{head}abcd").as_bytes()),
        Parsed::Complete(CallbackRequest {
            path: "/api/v1/wechat-client/wxid_bot/sync-message".into(),
            body: b"abcd".to_vec(),
        })
    );
    let empty = "POST /x/sync-message HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
    assert_eq!(
        parse_request(empty.as_bytes()),
        Parsed::Complete(CallbackRequest {
            path: "/x/sync-message".into(),
            body: vec![]
        })
    );
}

// ---------- planner ----------

fn planner(t0: Instant, login_age: Option<Duration>) -> SendPlanner {
    SendPlanner::new(login_age, t0, Box::new(|| 0.0))
}

/// Run the planner as the send loop would; returns `(seconds, chat, text)`.
fn drain(p: &mut SendPlanner, t0: Instant, until_secs: u64) -> Vec<(u64, String, String)> {
    let mut now = t0;
    let mut sent = Vec::new();
    while now <= t0 + Duration::from_secs(until_secs) {
        match p.next(now).0 {
            SendAction::Send { chat_id, text, .. } => {
                sent.push((now.duration_since(t0).as_secs(), chat_id, text));
                p.did_send(now);
            }
            SendAction::Wait(at) => now = at,
            SendAction::Idle => break,
        }
    }
    sent
}

#[test]
fn a_burst_of_notices_becomes_one_message() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    p.enqueue(ME, "#1 done", SendKind::Notice, 1, t0);
    let _ = p.next(t0);
    p.did_send(t0);
    for i in 2..=20 {
        p.enqueue(
            ME,
            &format!("#{i} done"),
            SendKind::Notice,
            i,
            t0 + Duration::from_secs(1),
        );
    }
    let sent = drain(&mut p, t0 + Duration::from_secs(1), 600);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, 29, "held until 30s after the last notice");
    assert!(sent[0]
        .2
        .starts_with(&format!("#2 done{NOTICE_SEPARATOR}#3 done")));
    assert!(sent[0].2.ends_with("#20 done"));
}

#[test]
fn replies_jump_queued_notices_and_are_never_merged() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    p.enqueue(ME, "n1", SendKind::Notice, 1, t0);
    p.enqueue(ME, "r1", SendKind::Reply, 2, t0);
    p.enqueue(ME, "r2", SendKind::Reply, 3, t0);
    let texts: Vec<String> = drain(&mut p, t0, 60).into_iter().map(|s| s.2).collect();
    assert_eq!(texts, ["r1", "r2", "n1"]);
}

#[test]
fn sends_keep_a_minimum_gap_plus_jitter() {
    let t0 = Instant::now();
    let mut p = SendPlanner::new(None, t0, Box::new(|| 0.5));
    p.enqueue(ME, "a", SendKind::Reply, 1, t0);
    p.enqueue(ME, "b", SendKind::Reply, 2, t0);
    let at: Vec<u64> = drain(&mut p, t0, 60).into_iter().map(|s| s.0).collect();
    assert_eq!(at, [0, 4], "3s gap + half of 2s jitter");
}

#[test]
fn the_per_minute_quota_delays_replies_without_dropping_them() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    for i in 0..12 {
        p.enqueue(ME, &format!("r{i}"), SendKind::Reply, i, t0);
    }
    let sent = drain(&mut p, t0, 600);
    assert_eq!(sent.len(), 12);
    assert!(sent.iter().filter(|s| s.0 < 60).count() <= 10);
}

#[test]
fn past_the_hourly_quota_notices_are_dropped_and_reported() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    for i in 0..100 {
        p.enqueue(ME, &format!("r{i}"), SendKind::Reply, i, t0);
    }
    let sent = drain(&mut p, t0, 3000);
    assert_eq!(sent.len(), 100);
    let now = t0 + Duration::from_secs(sent.last().unwrap().0 + 10);
    p.enqueue(ME, "dropped", SendKind::Notice, 500, now);
    let (action, dropped) = p.next(now);
    assert_eq!(action, SendAction::Idle);
    assert_eq!(dropped, vec![500]);

    let later = t0 + Duration::from_secs(3700);
    p.enqueue(ME, "answer", SendKind::Reply, 501, later);
    match p.next(later).0 {
        SendAction::Send { text, .. } => assert_eq!(text, "answer\n\n（已省略 1 条通知）"),
        other => panic!("expected a send, got {other:?}"),
    }
}

#[test]
fn a_long_reply_is_chunked_paced_and_settled_on_its_last_piece() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    let long = vec!["字".repeat(1000); 3].join("\n");
    p.enqueue(ME, &long, SendKind::Reply, 7, t0);
    let mut now = t0;
    let mut pieces = Vec::new();
    loop {
        match p.next(now).0 {
            SendAction::Send { text, tickets, .. } => {
                pieces.push((text.chars().count(), tickets));
                p.did_send(now);
            }
            SendAction::Wait(at) => now = at,
            SendAction::Idle => break,
        }
    }
    assert_eq!(pieces.len(), 3);
    assert!(pieces.iter().all(|(n, _)| *n <= MAX_CHARS));
    assert_eq!(
        pieces.iter().map(|p| p.1.clone()).collect::<Vec<_>>(),
        [vec![], vec![], vec![7]]
    );
}

#[test]
fn a_fresh_login_runs_the_stricter_policy() {
    let t0 = Instant::now();
    let p = planner(t0, Some(Duration::from_secs(3600)));
    assert_eq!(p.policy(t0), SendPolicy::FRESH_LOGIN);
    assert_eq!(p.policy(t0 + FRESH_LOGIN_PERIOD), SendPolicy::NORMAL);
    assert_eq!(planner(t0, None).policy(t0), SendPolicy::NORMAL);
}

#[test]
fn blank_text_queues_nothing() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    assert!(!p.enqueue(ME, "  \n", SendKind::Reply, 1, t0));
    assert_eq!(p.next(t0).0, SendAction::Idle);
}

#[test]
fn chunk_respects_the_limit_and_line_breaks() {
    assert_eq!(chunk("short", 10), vec!["short".to_string()]);
    let pieces = chunk("aaaa\nbbbb\ncccc", 9);
    assert_eq!(pieces, vec!["aaaa\nbbbb".to_string(), "cccc".to_string()]);
    assert_eq!(chunk("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
}

// ---------- end to end over loopback ----------

#[tokio::test]
async fn a_push_over_the_callback_port_reaches_the_sink() {
    use std::sync::Mutex as StdMutex;

    struct Collect(StdMutex<Vec<(String, bool)>>);
    #[async_trait::async_trait]
    impl InboundSink for Collect {
        async fn accept(&self, msg: InboundMessage) {
            self.0
                .lock()
                .unwrap()
                .push((msg.text, msg.addressed_to_bot));
        }
    }

    // Any free port; the gateway binds it itself.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut gw = WeChatPadGateway::new();
    gw.set_config(WeChatPadConfig {
        callback_port: port,
        // Unreachable on purpose: attach fails, inbound must still work.
        server_url: "http://127.0.0.1:1".into(),
        ..cfg()
    })
    .await;
    let sink = Arc::new(Collect(StdMutex::new(Vec::new())));
    gw.use_core_pipeline(sink.clone()).await;
    gw.start().await.unwrap();

    let now = chrono::Utc::now().timestamp() + 5;
    let mut m = add_msg(77, 1, ME, BOT, "/status", PLAIN_SOURCE);
    m["CreateTime"] = now.into();
    let mut old = add_msg(78, 1, ME, BOT, "history", PLAIN_SOURCE);
    old["CreateTime"] = 1.into();
    let body = push(serde_json::json!([m, old]));
    let resp = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!(
            "http://127.0.0.1:{port}/api/v1/wechat-client/{BOT}/sync-message"
        ))
        .body(body)
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());

    for _ in 0..50 {
        if !sink.0.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(*sink.0.lock().unwrap(), vec![("/status".to_string(), true)]);
    gw.shutdown().await;
}

// ---------- attachments ----------

#[test]
fn files_are_paced_and_never_merged_into_notices() {
    let t0 = Instant::now();
    let mut p = planner(t0, None);
    p.enqueue(ME, "done", SendKind::Notice, 1, t0);
    p.enqueue_media(ME, Media::Image(vec![1, 2, 3]), SendKind::Notice, 2, t0);
    p.enqueue(ME, "also done", SendKind::Notice, 3, t0);
    let mut now = t0;
    let mut sends = Vec::new();
    loop {
        match p.next(now).0 {
            SendAction::Send { text, media, .. } => {
                sends.push((now.duration_since(t0).as_secs(), text, media));
                p.did_send(now);
            }
            SendAction::Wait(at) => now = at,
            SendAction::Idle => break,
        }
    }
    assert_eq!(
        sends.len(),
        2,
        "two notices merge; the image stays its own send"
    );
    assert_eq!(sends[0].1, format!("done{NOTICE_SEPARATOR}also done"));
    assert_eq!(sends[1].2, Some(Media::Image(vec![1, 2, 3])));
    assert!(sends[1].0 >= 3, "the image waits out the gap like any send");
}

#[test]
fn the_multipart_body_carries_the_chunk_and_every_field() {
    let (ct, body) = multipart(
        "a\"b.txt",
        b"DATA",
        &[("Wxid", "wxid_bot".into()), ("TotalLen", "4".into())],
    );
    let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
    let text = String::from_utf8(body).unwrap();
    assert!(text.starts_with(&format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"chunk\"; filename=\"a_b.txt\""
    )));
    assert!(text.contains("\r\n\r\nDATA\r\n"));
    assert!(text.contains("name=\"Wxid\"\r\n\r\nwxid_bot\r\n"));
    assert!(text.ends_with(&format!("--{boundary}--\r\n")));
}

#[test]
fn images_go_inline_and_everything_else_as_a_file() {
    assert!(is_inline_image("image/png", "x"));
    assert!(is_inline_image("application/octet-stream", "horse.JPG"));
    assert!(!is_inline_image("application/pdf", "report.pdf"));
    assert!(!is_inline_image("image/svg+xml", "logo.svg"));
}

#[tokio::test]
async fn deliver_sends_the_text_then_the_image() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let ok = ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "Success": true, "Code": 0, "Message": "", "Data": {"List": [{"NewMsgId": 9}]}
    }));
    for p in [
        "/api/User/GetContractProfile",
        "/api/Login/AutoHeartBeat",
        "/api/Msg/SendTxt",
        "/api/Msg/UploadImg",
    ] {
        Mock::given(method("POST"))
            .and(path(p))
            .respond_with(ok.clone())
            .mount(&server)
            .await;
    }

    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("horse.png");
    std::fs::write(&png, b"\x89PNG fake").unwrap();

    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut gw = WeChatPadGateway::new();
    gw.set_config(WeChatPadConfig {
        callback_port: port,
        server_url: server.uri(),
        ..cfg()
    })
    .await;
    gw.start().await.unwrap();
    let driver = gw.as_driver().await;

    let to = Conversation {
        channel: CHANNEL,
        bot_id: Some(BOT.into()),
        kind: ConversationKind::Direct,
        id: ME.into(),
    };
    driver
        .deliver(
            &to,
            Some("1"),
            &OutboundMessage {
                text: "马画好啦".into(),
                attachments: vec![crate::driver::SessionAttachment {
                    filename: "horse.png".into(),
                    mime: "image/png".into(),
                    bucket_path: "b/horse.png".into(),
                    local_path: Some(png.to_string_lossy().into_owned()),
                }],
                question: None,
            },
        )
        .await
        .unwrap();

    let sends: Vec<(String, serde_json::Value)> = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path().starts_with("/api/Msg/"))
        .map(|r| {
            (
                r.url.path().to_string(),
                serde_json::from_slice(&r.body).unwrap(),
            )
        })
        .collect();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].0, "/api/Msg/SendTxt");
    assert_eq!(sends[0].1["Content"], "马画好啦");
    assert_eq!(sends[1].0, "/api/Msg/UploadImg");
    assert_eq!(sends[1].1["ToWxid"], ME);
    use base64::Engine;
    assert_eq!(
        sends[1].1["Base64"],
        base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake")
    );
    gw.shutdown().await;
}
