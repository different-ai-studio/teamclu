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

pub const CONNECTING_TEXT: &str =
    "这个窗口是在 TeamClu 打不开时用的。\n\n正在连接。连上之后会显示一个短码，你把它告诉支持人员。";

fn purpose() -> &'static str {
    "这个窗口是在 TeamClu 打不开时用的。连上之后会显示一个短码，告诉支持人员。点「允许」之后，对方才能看到这台电脑的日志。"
}

pub fn view_for_status(
    status: &str,
    code: &str,
    name: Option<&str>,
    conclusion: Option<&str>,
) -> Screen {
    match status {
        "waiting" => screen(
            format!(
                "{}\n\n短码\n{code}\n\n下一步：把短码告诉支持人员，并留在这个窗口。对方接入后，这里会请你点「允许」。点允许之前，不会上传日志。",
                purpose()
            ),
            false,
            false,
            true,
            false,
            false,
        ),
        "redeemed" => {
            let name = name.filter(|value| !value.is_empty()).unwrap_or("支持人员");
            screen(
                format!(
                    "{name} 已接入，想查看这台电脑的日志，用来查 TeamClu 为什么打不开。\n\n下一步：点「允许」才会上传。点「拒绝」则什么都不传。"
                ),
                true,
                true,
                false,
                false,
                false,
            )
        }
        "allowed" => screen(
            "正在把日志发给支持人员。\n\n下一步：留在这个窗口，等结论出现。".into(),
            false,
            false,
            true,
            false,
            false,
        ),
        "concluded" => {
            let body = conclusion.unwrap_or("").trim();
            let text = if body.is_empty() {
                "支持人员还没有写下结论。\n\n下一步：可以点「结束」关掉这个窗口。".to_string()
            } else {
                format!("{body}\n\n这是支持人员看完日志后的结论。下一步：看完后点「结束」。")
            };
            screen(text, false, false, true, false, false)
        }
        "expired" => screen(
            "这个短码已经过期，支持人员用不了。\n\n下一步：点「重新生成」，把新的短码再告诉支持人员。".into(),
            false,
            false,
            true,
            true,
            false,
        ),
        "rejected" | "closed" => screen(
            "这次支持已经结束。\n\n下一步：TeamClu 还是打不开的话，重新打开这个窗口，会得到一个新短码。".into(),
            false,
            false,
            true,
            false,
            false,
        ),
        other => screen(
            format!("{other}\n\n下一步：点「结束」。需要的话，重新打开这个窗口再要一个短码。"),
            false,
            false,
            true,
            false,
            false,
        ),
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
            return self.offline("还没有配置服务器地址，短码出不来。");
        }
        match http::create_session(&self.api, &self.phase) {
            Ok(opened) => {
                let code = opened.code.clone();
                self.session_id = Some(opened.id);
                self.code = Some(opened.code);
                view_for_status("waiting", &code, None, None)
            }
            Err(err) => self.offline(&format!("现在连不上，短码出不来。\n\n详情：{err}")),
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
                format!("刚才没有传出去。\n\n下一步：再点一次「允许」。还是不行就点「拒绝」，把短码重新告诉支持人员。\n\n详情：{err}"),
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
                let record = self.save_local_record();
                screen(
                    format!(
                        "日志没有传出去。\n\n下一步：点「打开记录文件夹」，把里面的「诊断记录.json」发给支持人员。\n\n记录文件\n{record}\n\n详情：{err}",
                        record = record.display()
                    ),
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

    pub fn record_path(&self) -> PathBuf {
        self.journal_dir().join("诊断记录.json")
    }

    /// Writes the same bundle the upload would have sent, so the folder has a file to hand over.
    pub fn save_local_record(&self) -> PathBuf {
        let path = self.record_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let bundle = crate::gather::bundle(&self.phase);
        if let Ok(text) = serde_json::to_string_pretty(&bundle) {
            let _ = std::fs::write(&path, text);
        }
        path
    }

    pub fn prepare_journal_dir(&self) -> PathBuf {
        let _ = self.save_local_record();
        self.journal_dir()
    }

    fn offline(&self, message: &str) -> Screen {
        let record = self.save_local_record();
        screen(
            format!(
                "{}\n\n{message}\n\n下一步：点「打开记录文件夹」，把里面的「诊断记录.json」发给支持人员。那是这台电脑的日志。\n\n记录文件\n{}",
                purpose(),
                record.display()
            ),
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
        assert!(screen.text.contains("看 journal"));
        assert!(screen.text.contains("下一步"));
        assert!(screen.end);
        assert!(!screen.allow);
    }

    #[test]
    fn offline_writes_a_record_file_into_the_folder() {
        let dir =
            std::env::temp_dir().join(format!("teamclu-support-record-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let journal = dir.join("journal.jsonl");
        let mut session = super::Session::new("manual", "", journal);
        let screen = session.start();
        let record = dir.join("诊断记录.json");
        let text = std::fs::read_to_string(&record).expect("record file");
        assert!(text.contains("\"snapshot\""));
        assert!(screen.text.contains("诊断记录.json"));
        assert!(screen.folder);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn waiting_says_who_it_is_for_and_the_next_step() {
        let screen = view_for_status("waiting", "ABCD-EFGH", None, None);
        assert!(screen.text.contains("TeamClu 打不开"));
        assert!(screen.text.contains("ABCD-EFGH"));
        assert!(screen.text.contains("下一步"));
        assert!(screen.text.contains("允许"));
        assert!(screen.end);
        assert!(!screen.allow);
    }
}
