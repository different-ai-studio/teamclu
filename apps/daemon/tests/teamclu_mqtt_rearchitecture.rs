// `subscriber` parses `voice/ctl` into `crate::voice::ctl::VoiceCtl`, so this
// crate root needs `voice` even though it only pulls in two mqtt submodules.
#[path = "../src/voice/mod.rs"]
mod voice;

#[path = "../src/mqtt/subscriber.rs"]
mod subscriber;
#[path = "../src/mqtt/topics.rs"]
mod topics;

mod proto {
    pub use teamclu_proto::amux;
}

use topics::Topics;

#[test]
fn builds_new_actor_and_live_topics() {
    let topics = Topics::new("team1", "actor-a");

    assert_eq!(topics.actor_rpc_req(), "amux/team1/actor-a/rpc/req");
    assert_eq!(topics.actor_rpc_res(), "amux/team1/actor-a/rpc/res");
    assert_eq!(topics.actor_notify(), "amux/team1/actor-a/notify");
    assert_eq!(
        topics.session_live("sess-1"),
        "amux/team1/session/sess-1/live"
    );
}

#[tokio::test]
async fn parse_session_live_and_actor_notify_topics() {
    let live = rumqttc::Publish::new(
        "amux/team1/session/sess-1/live",
        rumqttc::QoS::AtLeastOnce,
        vec![1, 2, 3],
    );
    let notify = rumqttc::Publish::new(
        "amux/team1/actor-a/notify",
        rumqttc::QoS::AtLeastOnce,
        vec![4, 5, 6],
    );

    assert!(matches!(
        subscriber::parse_incoming(&live),
        Some(subscriber::IncomingMessage::TeamcluSessionLive { .. })
    ));
    assert!(matches!(
        subscriber::parse_incoming(&notify),
        Some(subscriber::IncomingMessage::TeamcluNotify { .. })
    ));
}

#[test]
fn reject_legacy_teamclu_topics_after_rearchitecture() {
    let global_ideas =
        rumqttc::Publish::new("amux/team1/ideas", rumqttc::QoS::AtLeastOnce, vec![7, 8, 9]);
    let legacy_message = rumqttc::Publish::new(
        "amux/team1/session/sess-1/messages",
        rumqttc::QoS::AtLeastOnce,
        vec![],
    );
    let legacy_idea = rumqttc::Publish::new(
        "amux/team1/session/sess-1/ideas",
        rumqttc::QoS::AtLeastOnce,
        vec![],
    );
    let legacy_meta = rumqttc::Publish::new(
        "amux/team1/actor/member-a/session/sess-1/meta",
        rumqttc::QoS::AtLeastOnce,
        vec![],
    );

    assert!(subscriber::parse_incoming(&global_ideas).is_none());
    assert!(subscriber::parse_incoming(&legacy_message).is_none());
    assert!(subscriber::parse_incoming(&legacy_idea).is_none());
    assert!(subscriber::parse_incoming(&legacy_meta).is_none());
}
