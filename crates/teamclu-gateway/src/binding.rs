//! Stable URI/URN helpers for gateway sessions and external actors.
//!
//! Binding URI shape per spec:
//!   wecom://{corp_id}/{agent_id}/single/{userid}
//!   wecom://{corp_id}/{agent_id}/external-single/{external_userid}
//!   wecom://{corp_id}/{agent_id}/group/{chat_id}
//!   feishu://{app_id}/{chat_id}
//!   discord://{application_id}/{channel_id}
//!   kook://{guild_id_or_dm}/{channel_id}
//!   wechat://{ilink_account}/single/{from_user_id}
//!   wechatpad://{account_wxid}/single/{wxid}
//!   wechatpad://{account_wxid}/group/{chatroom_id}
//!   email://{account_key}/thread/{thread_key}

pub fn wecom_dm(corp_id: &str, agent_id: &str, userid: &str) -> String {
    format!("wecom://{corp_id}/{agent_id}/single/{userid}")
}
pub fn wecom_external_dm(corp_id: &str, agent_id: &str, ext_userid: &str) -> String {
    format!("wecom://{corp_id}/{agent_id}/external-single/{ext_userid}")
}
pub fn wecom_group(corp_id: &str, agent_id: &str, chat_id: &str) -> String {
    format!("wecom://{corp_id}/{agent_id}/group/{chat_id}")
}
pub fn feishu(app_id: &str, chat_id: &str) -> String {
    format!("feishu://{app_id}/{chat_id}")
}
pub fn discord(application_id: &str, channel_id: &str) -> String {
    format!("discord://{application_id}/{channel_id}")
}
pub fn kook(scope: &str, channel_id: &str) -> String {
    format!("kook://{scope}/{channel_id}")
}
pub fn wechat_dm(ilink_account: &str, from_user_id: &str) -> String {
    format!("wechat://{ilink_account}/single/{from_user_id}")
}
pub fn wechatpad_dm(account_wxid: &str, wxid: &str) -> String {
    format!("wechatpad://{account_wxid}/single/{wxid}")
}
pub fn wechatpad_group(account_wxid: &str, chatroom_id: &str) -> String {
    format!("wechatpad://{account_wxid}/group/{chatroom_id}")
}
pub fn email_thread(account_key: &str, thread_key: &str) -> String {
    format!("email://{account_key}/thread/{thread_key}")
}
pub fn seatalk_group(app_id: &str, group_id: &str) -> String {
    format!("seatalk://{app_id}/group/{group_id}")
}
pub fn seatalk_group_thread(app_id: &str, group_id: &str, thread_id: &str) -> String {
    format!("seatalk://{app_id}/group/{group_id}/thread/{thread_id}")
}
pub fn seatalk_dm(app_id: &str, employee_code: &str) -> String {
    format!("seatalk://{app_id}/single/{employee_code}")
}
pub fn seatalk_dm_thread(app_id: &str, employee_code: &str, thread_id: &str) -> String {
    format!("seatalk://{app_id}/single/{employee_code}/thread/{thread_id}")
}

pub fn urn_wecom_user(corp_id: &str, userid: &str) -> String {
    format!("wecom-user:{corp_id}:{userid}")
}
pub fn urn_wecom_ext(corp_id: &str, ext_userid: &str) -> String {
    format!("wecom-ext:{corp_id}:{ext_userid}")
}
pub fn urn_feishu_user(app_id: &str, open_id: &str) -> String {
    format!("feishu-user:{app_id}:{open_id}")
}
pub fn urn_discord_user(user_id: &str) -> String {
    format!("discord-user:{user_id}")
}
pub fn urn_kook_user(user_id: &str) -> String {
    format!("kook-user:{user_id}")
}
pub fn urn_wechat_user(ilink_account: &str, from_user_id: &str) -> String {
    format!("wechat-user:{ilink_account}:{from_user_id}")
}
pub fn urn_wechatpad_user(account_wxid: &str, wxid: &str) -> String {
    format!("wechatpad-user:{account_wxid}:{wxid}")
}
pub fn urn_email_user(addr: &str) -> String {
    format!("email-user:{}", addr.to_lowercase())
}
pub fn urn_seatalk_user(app_id: &str, employee_code: &str) -> String {
    format!("seatalk-user:{app_id}:{employee_code}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wecom_uris_round_trip() {
        assert_eq!(wecom_dm("c1", "a1", "bob"), "wecom://c1/a1/single/bob");
        assert_eq!(wecom_group("c1", "a1", "g1"), "wecom://c1/a1/group/g1");
    }
    #[test]
    fn email_urn_lowercases_addr() {
        assert_eq!(urn_email_user("Foo@Bar.com"), "email-user:foo@bar.com");
    }
}
