use std::path::{Path, PathBuf};

use crate::http;

pub struct Screen {
    pub text: String,
    pub allow: bool,
    pub reject: bool,
    pub end: bool,
    pub regen: bool,
    pub folder: bool,
    pub quit: bool,
}

fn screen(text: String, allow: bool, reject: bool, end: bool, regen: bool, folder: bool) -> Screen {
    Screen {
        text,
        allow,
        reject,
        end,
        regen,
        folder,
        quit: false,
    }
}

pub fn view_for_status(
    status: &str,
    code: &str,
    name: Option<&str>,
    conclusion: Option<&str>,
) -> Screen {
    match status {
        "waiting" => screen(
            format!("短码 {code}\n\n等待支持人员"),
            false,
            false,
            true,
            false,
            false,
        ),
        "redeemed" => {
            let name = name.filter(|value| !value.is_empty()).unwrap_or("支持人员");
            screen(
                format!("{name} 想查看诊断信息。\n点允许后才会上传。"),
                true,
                true,
                false,
                false,
                false,
            )
        }
        "allowed" => screen("正在发送".into(), false, false, true, false, false),
        "concluded" => screen(
            conclusion.unwrap_or("").to_string(),
            false,
            false,
            true,
            false,
            false,
        ),
        "expired" => screen("短码已过期".into(), false, false, true, true, false),
        "rejected" | "closed" => screen("已结束".into(), false, false, true, false, false),
        other => screen(other.to_string(), false, false, true, false, false),
    }
}

pub struct Session {
    phase: String,
    api: String,
    pub journal: PathBuf,
    session_id: Option<String>,
    code: Option<String>,
    uploaded: bool,
}

impl Session {
    pub fn new(phase: &str, api: &str, journal: PathBuf) -> Self {
        Self {
            phase: phase.to_string(),
            api: api.to_string(),
            journal,
            session_id: None,
            code: None,
            uploaded: false,
        }
    }

    pub fn journal_dir(&self) -> PathBuf {
        self.journal
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub fn start(&mut self) -> Screen {
        self.uploaded = false;
        self.session_id = None;
        self.code = None;
        if self.api.is_empty() {
            return self.offline("未配置 Cloud API 地址。");
        }
        match http::create_session(&self.api, &self.phase) {
            Ok(opened) => {
                let code = opened.code.clone();
                self.session_id = Some(opened.id);
                self.code = Some(opened.code);
                view_for_status("waiting", &code, None, None)
            }
            Err(err) => self.offline(&format!("连不上。\n{err}")),
        }
    }

    pub fn poll(&mut self) -> Option<Screen> {
        let id = self.session_id.clone()?;
        let code = self.code.clone()?;
        if self.api.is_empty() {
            return None;
        }
        let polled = http::poll_session(&self.api, &id, &code).ok()?;
        if polled.status == "allowed" && !self.uploaded {
            self.uploaded = true;
            return Some(self.upload_now());
        }
        Some(view_for_status(
            &polled.status,
            &code,
            polled.support_display_name.as_deref(),
            polled.conclusion.as_deref(),
        ))
    }

    pub fn allow(&mut self) -> Screen {
        let (Some(id), Some(code)) = (self.session_id.clone(), self.code.clone()) else {
            return self.offline("还没有短码。");
        };
        self.uploaded = true;
        if let Err(err) = http::allow_session(&self.api, &id, &code) {
            self.uploaded = false;
            return screen(
                format!("允许失败。\n{err}"),
                true,
                true,
                false,
                false,
                false,
            );
        }
        self.upload_now()
    }

    pub fn reject(&mut self) -> Screen {
        self.close("user_rejected");
        view_for_status("rejected", "", None, None)
    }

    pub fn end(&mut self) -> Screen {
        self.close("user_closed");
        let mut shown = view_for_status("closed", "", None, None);
        shown.quit = true;
        shown
    }

    pub fn regen(&mut self) -> Screen {
        self.session_id = None;
        self.code = None;
        self.start()
    }

    fn upload_now(&mut self) -> Screen {
        let (Some(id), Some(code)) = (self.session_id.clone(), self.code.clone()) else {
            return view_for_status("allowed", "", None, None);
        };
        let bundle = crate::gather::bundle(&self.phase);
        match http::upload_bundle(&self.api, &id, &code, &bundle) {
            Ok(()) => view_for_status("allowed", &code, None, None),
            Err(err) if err.contains("409") => view_for_status("allowed", &code, None, None),
            Err(err) => {
                self.uploaded = false;
                screen(
                    format!("发送失败。\n{err}\n\n记录在\n{}", self.journal.display()),
                    false,
                    false,
                    true,
                    false,
                    true,
                )
            }
        }
    }

    fn close(&mut self, reason: &str) {
        if let (Some(id), Some(code)) = (self.session_id.clone(), self.code.clone()) {
            if !self.api.is_empty() {
                let _ = http::close_session(&self.api, &id, &code, reason);
            }
        }
        self.session_id = None;
        self.code = None;
    }

    fn offline(&self, message: &str) -> Screen {
        screen(
            format!("{message}\n\n记录在\n{}", self.journal.display()),
            false,
            false,
            true,
            false,
            true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::view_for_status;

    #[test]
    fn redeemed_names_the_supporter_and_offers_allow() {
        let screen = view_for_status("redeemed", "ABCD-EFGH", Some("Ada"), None);
        assert!(screen.text.contains("Ada"));
        assert!(screen.allow && screen.reject);
        assert!(!screen.end);
    }

    #[test]
    fn expired_offers_a_new_code() {
        let screen = view_for_status("expired", "ABCD-EFGH", None, None);
        assert!(screen.text.contains("过期"));
        assert!(screen.regen && screen.end);
        assert!(!screen.quit);
    }

    #[test]
    fn concluded_shows_the_text() {
        let screen = view_for_status("concluded", "ABCD-EFGH", None, Some("看 journal"));
        assert_eq!(screen.text, "看 journal");
        assert!(screen.end);
        assert!(!screen.allow);
    }
}
