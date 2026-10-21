//! Read cursor for SeaTalk threads.
//!
//! The thread API returns the last 7 days, not an unread slice. This file is
//! the bot's own mark of what it has already handed to the agent. It lives
//! under the team state dir because a restart must not replay that history,
//! and a different team must not inherit it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Weak;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedMutexGuard};

/// Newest unread messages copied into one prompt. Older ones stay unread in
/// SeaTalk and are not backfilled on the next mention.
pub(crate) const MAX_UNREAD_MESSAGES: usize = 50;

pub(crate) const MAX_THREAD_PAGES: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryMessage {
    pub message_id: String,
    pub sent_time: i64,
    pub sender: String,
    pub body: String,
    pub image_url: Option<String>,
    pub image_name: Option<String>,
}

/// A bot reply that is already read, but newer than the watermark. The
/// watermark stays on the last message handed to the agent, so a message that
/// arrived while the agent was replying is still unread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReadAhead {
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "sentTime")]
    pub sent_time: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredCursor {
    #[serde(rename = "sentTime")]
    pub sent_time: i64,
    /// Message ids that share `sent_time`. SeaTalk ids are not an order, so a
    /// single id cannot tell same-second siblings apart.
    #[serde(rename = "messageIds")]
    pub message_ids: Vec<String>,
    #[serde(default, rename = "readAhead")]
    pub read_ahead: Vec<ReadAhead>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadMark {
    pub sent_time: i64,
    pub message_ids: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct CursorFile {
    #[serde(default)]
    cursors: HashMap<String, StoredCursor>,
}

pub struct CursorStore {
    path: PathBuf,
    inner: Mutex<CursorFile>,
    gates: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl CursorStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create seatalk cursor dir: {e}"))?;
        }
        let cursors = if path.exists() {
            let bytes = std::fs::read(&path).map_err(|e| format!("read seatalk cursors: {e}"))?;
            serde_json::from_slice(&bytes).unwrap_or_default()
        } else {
            CursorFile::default()
        };
        Ok(Self {
            path,
            inner: Mutex::new(cursors),
            gates: Mutex::new(HashMap::new()),
        })
    }

    /// One in-flight mention per thread. The guard is held until the inbound
    /// row is written (or the message is dropped), so a second @ does not read
    /// the cursor the first one has not saved yet.
    pub(crate) async fn lock_thread(&self, key: &str) -> OwnedMutexGuard<()> {
        let mutex = {
            let mut gates = self.gates.lock().await;
            gates.retain(|_, gate| gate.strong_count() > 0);
            if let Some(existing) = gates.get(key).and_then(Weak::upgrade) {
                existing
            } else {
                let created = std::sync::Arc::new(Mutex::new(()));
                gates.insert(key.to_string(), std::sync::Arc::downgrade(&created));
                created
            }
        };
        mutex.lock_owned().await
    }

    pub(crate) async fn get(&self, key: &str) -> Option<StoredCursor> {
        self.inner.lock().await.cursors.get(key).cloned()
    }

    pub(crate) async fn advance(
        &self,
        key: &str,
        sent_time: i64,
        message_ids: &[String],
    ) -> Result<(), String> {
        let mut file = self.inner.lock().await;
        let entry = file.cursors.entry(key.to_string()).or_insert(StoredCursor {
            sent_time: i64::MIN,
            message_ids: Vec::new(),
            read_ahead: Vec::new(),
        });
        if sent_time > entry.sent_time {
            entry.sent_time = sent_time;
            entry.message_ids = message_ids.to_vec();
        } else if sent_time == entry.sent_time {
            for id in message_ids {
                if !entry.message_ids.iter().any(|existing| existing == id) {
                    entry.message_ids.push(id.clone());
                }
            }
        }
        fold_read_ahead(entry);
        save(&self.path, &file)
    }

    /// Remember a bot reply without moving the watermark past messages the
    /// agent has not seen yet.
    pub(crate) async fn note_reply(
        &self,
        key: &str,
        sent_time: i64,
        message_id: &str,
    ) -> Result<(), String> {
        if sent_time <= 0 || message_id.is_empty() {
            return Ok(());
        }
        let mut file = self.inner.lock().await;
        if let Some(entry) = file.cursors.get(key) {
            if sent_time < entry.sent_time
                || entry
                    .read_ahead
                    .iter()
                    .any(|item| item.message_id == message_id)
                || (sent_time == entry.sent_time
                    && entry.message_ids.iter().any(|id| id == message_id))
            {
                return Ok(());
            }
        }
        let entry = file.cursors.entry(key.to_string()).or_insert(StoredCursor {
            sent_time: i64::MIN,
            message_ids: Vec::new(),
            read_ahead: Vec::new(),
        });
        if sent_time == entry.sent_time {
            entry.message_ids.push(message_id.to_string());
        } else {
            entry.read_ahead.push(ReadAhead {
                message_id: message_id.to_string(),
                sent_time,
            });
        }
        save(&self.path, &file)
    }
}

fn fold_read_ahead(entry: &mut StoredCursor) {
    let mut folded = Vec::new();
    entry.read_ahead.retain(|item| {
        if item.sent_time > entry.sent_time {
            true
        } else {
            if item.sent_time == entry.sent_time {
                folded.push(item.message_id.clone());
            }
            false
        }
    });
    for id in folded {
        if !entry.message_ids.iter().any(|existing| existing == &id) {
            entry.message_ids.push(id);
        }
    }
}

pub(crate) fn thread_key(app_id: &str, kind: &str, chat_id: &str, thread_id: &str) -> String {
    format!("{app_id}\u{1f}{kind}\u{1f}{chat_id}\u{1f}{thread_id}")
}

pub(crate) fn is_unread(message: &HistoryMessage, cursor: Option<&StoredCursor>) -> bool {
    let Some(cursor) = cursor else {
        return true;
    };
    if cursor
        .read_ahead
        .iter()
        .any(|item| item.message_id == message.message_id)
    {
        return false;
    }
    if message.sent_time > cursor.sent_time {
        return true;
    }
    if message.sent_time == cursor.sent_time {
        return !cursor
            .message_ids
            .iter()
            .any(|id| id == &message.message_id);
    }
    false
}

/// Unread messages in the order they were sent. The thread API is oldest
/// first; sorting by `sent_time` keeps the root at the top either way.
/// Above `limit`, the newest messages are the ones kept.
pub(crate) fn select_unread(
    page: &[HistoryMessage],
    cursor: Option<&StoredCursor>,
    exclude: &HashSet<&str>,
    limit: usize,
) -> Vec<HistoryMessage> {
    let mut unread: Vec<HistoryMessage> = page
        .iter()
        .filter(|message| {
            !exclude.contains(message.message_id.as_str()) && is_unread(message, cursor)
        })
        .cloned()
        .collect();
    unread.sort_by(|a, b| {
        a.sent_time
            .cmp(&b.sent_time)
            .then_with(|| a.message_id.cmp(&b.message_id))
    });
    if unread.len() > limit {
        let drop = unread.len() - limit;
        unread.drain(..drop);
    }
    unread
}

pub(crate) fn format_thread_history(messages: &[HistoryMessage]) -> Option<String> {
    if messages.is_empty() {
        return None;
    }
    let lines: Vec<String> = messages
        .iter()
        .map(|message| {
            let body = message.body.replace('\n', " ");
            let body = body.trim();
            let body = if body.is_empty() { "[empty]" } else { body };
            format!("{}: {body}", message.sender)
        })
        .collect();
    Some(format!(
        "[Thread history]\n{}\n[End thread history]",
        lines.join("\n")
    ))
}

/// The mark to save after this mention. Ids are only those at the newest
/// timestamp, which is what [`is_unread`] compares against.
pub(crate) fn next_read_mark(
    current_id: &str,
    current_sent: Option<i64>,
    included: &[HistoryMessage],
) -> Option<ReadMark> {
    let mut best: Option<i64> = None;
    let mut ids: Vec<String> = Vec::new();
    let mut consider = |sent_time: i64, message_id: &str| match best {
        Some(current) if sent_time > current => {
            best = Some(sent_time);
            ids.clear();
            ids.push(message_id.to_string());
        }
        Some(current) if sent_time == current && !ids.iter().any(|id| id == message_id) => {
            ids.push(message_id.to_string());
        }
        None => {
            best = Some(sent_time);
            ids.push(message_id.to_string());
        }
        _ => {}
    };
    if let Some(sent_time) = current_sent {
        consider(sent_time, current_id);
    }
    for message in included {
        consider(message.sent_time, &message.message_id);
    }
    best.map(|sent_time| ReadMark {
        sent_time,
        message_ids: ids,
    })
}

fn save(path: &Path, file: &CursorFile) -> Result<(), String> {
    let data =
        serde_json::to_vec_pretty(file).map_err(|e| format!("encode seatalk cursors: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("write seatalk cursors: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace seatalk cursors: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, sent: i64, body: &str) -> HistoryMessage {
        HistoryMessage {
            message_id: id.into(),
            sent_time: sent,
            sender: "a@b.com".into(),
            body: body.into(),
            image_url: None,
            image_name: None,
        }
    }

    #[test]
    fn unread_is_strictly_after_the_cursor_including_same_second_siblings() {
        let cursor = StoredCursor {
            sent_time: 10,
            message_ids: vec!["a".into()],
            read_ahead: Vec::new(),
        };
        assert!(!is_unread(&msg("a", 10, "seen"), Some(&cursor)));
        assert!(is_unread(&msg("b", 10, "sibling"), Some(&cursor)));
        assert!(!is_unread(&msg("c", 9, "old"), Some(&cursor)));
        assert!(is_unread(&msg("d", 11, "new"), Some(&cursor)));
        assert!(is_unread(&msg("e", 1, "first"), None));
    }

    #[test]
    fn history_is_oldest_first_even_when_the_page_is_not() {
        let cursor = StoredCursor {
            sent_time: 10,
            message_ids: vec!["a".into()],
            read_ahead: Vec::new(),
        };
        let page = vec![
            msg("now", 12, "current"),
            msg("d", 11, "new"),
            msg("b", 10, "sibling"),
            msg("a", 10, "seen"),
            msg("c", 9, "old"),
        ];
        let exclude: HashSet<&str> = HashSet::from(["now"]);
        let unread = select_unread(&page, Some(&cursor), &exclude, 50);
        assert_eq!(
            unread
                .iter()
                .map(|m| m.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "d"]
        );
    }

    #[test]
    fn the_cap_keeps_the_newest_then_shows_them_oldest_first() {
        let page: Vec<_> = (0..60).map(|n| msg(&format!("m{n}"), n, "x")).collect();
        let unread = select_unread(&page, None, &HashSet::new(), 50);
        assert_eq!(unread.len(), 50);
        assert_eq!(unread[0].message_id, "m10");
        assert_eq!(unread[49].message_id, "m59");
    }

    #[test]
    fn history_block_is_chronological_and_one_line_per_message() {
        let unread = select_unread(
            &[msg("b", 2, "second"), msg("a", 1, "first\nline")],
            None,
            &HashSet::new(),
            50,
        );
        let text = format_thread_history(&unread).unwrap();
        assert_eq!(
            text,
            "[Thread history]\na@b.com: first line\na@b.com: second\n[End thread history]"
        );
    }

    #[test]
    fn the_mark_keeps_only_ids_at_the_newest_timestamp() {
        let included = vec![
            msg("h1", 5, "old"),
            msg("h2", 8, "mid"),
            msg("h3", 8, "mid2"),
        ];
        let mark = next_read_mark("cur", Some(9), &included).unwrap();
        assert_eq!(mark.sent_time, 9);
        assert_eq!(mark.message_ids, vec!["cur".to_string()]);

        let mark = next_read_mark("cur", None, &included).unwrap();
        assert_eq!(mark.sent_time, 8);
        assert_eq!(mark.message_ids, vec!["h2".to_string(), "h3".to_string()]);
    }

    #[tokio::test]
    async fn the_cursor_file_survives_a_reopen() {
        let path = std::env::temp_dir().join(format!(
            "seatalk-cursors-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = CursorStore::open(&path).unwrap();
        let key = thread_key("app", "group", "g1", "t1");
        store
            .advance(&key, 20, &["m1".into(), "m2".into()])
            .await
            .unwrap();
        store.advance(&key, 20, &["m3".into()]).await.unwrap();
        store.advance(&key, 10, &["old".into()]).await.unwrap();
        drop(store);

        let reopened = CursorStore::open(&path).unwrap();
        let cursor = reopened.get(&key).await.unwrap();
        assert_eq!(cursor.sent_time, 20);
        assert_eq!(cursor.message_ids, vec!["m1", "m2", "m3"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_reply_ahead_of_the_watermark_is_read_and_the_gap_stays_unread() {
        let cursor = StoredCursor {
            sent_time: 10,
            message_ids: vec!["asked".into()],
            read_ahead: vec![ReadAhead {
                message_id: "reply".into(),
                sent_time: 30,
            }],
        };
        assert!(!is_unread(&msg("reply", 30, "bot"), Some(&cursor)));
        assert!(is_unread(
            &msg("during", 20, "while you typed"),
            Some(&cursor)
        ));
        assert!(is_unread(&msg("same-second", 30, "sibling"), Some(&cursor)));
    }

    #[tokio::test]
    async fn noting_a_reply_does_not_move_the_watermark() {
        let path = std::env::temp_dir().join(format!(
            "seatalk-cursors-reply-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = CursorStore::open(&path).unwrap();
        let key = thread_key("app", "group", "g1", "t1");
        store.advance(&key, 10, &["asked".into()]).await.unwrap();
        store.note_reply(&key, 10, "same-second").await.unwrap();
        store.note_reply(&key, 30, "reply").await.unwrap();

        let cursor = store.get(&key).await.unwrap();
        assert_eq!(cursor.sent_time, 10);
        assert_eq!(cursor.message_ids, vec!["asked", "same-second"]);
        assert!(is_unread(&msg("during", 20, "gap"), Some(&cursor)));
        assert!(!is_unread(&msg("reply", 30, "bot"), Some(&cursor)));

        store.advance(&key, 40, &["next".into()]).await.unwrap();
        let cursor = store.get(&key).await.unwrap();
        assert!(cursor.read_ahead.is_empty());
        assert!(!is_unread(&msg("reply", 30, "bot"), Some(&cursor)));
        let _ = std::fs::remove_file(&path);
    }
}
