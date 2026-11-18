#[path = "idea_store.rs"]
pub mod idea_store;
pub mod live;
pub mod message_store;
pub mod notify;
pub mod rpc;
pub mod session_manager;
pub mod session_store;

// The pre-rebrand `~/.amuxd/teamclaw` → `~/.amuxd/teamclu` migration that
// lived here is gone: the stores moved to `teams/<id>/state/sessions/`, so the
// rename only resurrected a root directory nothing reads and the one-shot v1
// purge (which lists both spellings) would never clean again.

pub use idea_store::{IdeaStore, StoredClaim, StoredIdea, StoredSubmission};
pub use live::LivePublisher;
pub use message_store::{MessageStore, StoredMessage};
pub use notify::NotifyPublisher;
pub use session_manager::{MessageDedup, SessionManager};
pub use session_store::{StoredParticipant, StoredSession, TeamcluSessionStore};
