//! Cross-platform child-process spawning helpers.
//!
//! amuxd is a console-subsystem binary, so on Windows it may run with no
//! console of its own (started detached, or from the GUI desktop app). Every
//! console child it then spawns — `opencode serve`, the node/pi hosts, the
//! bridges, `tasklist`/`taskkill`, `npm`, `git` — would get its own **visible**
//! console window unless the parent sets `CREATE_NO_WINDOW` (0x08000000).
//!
//! This mirrors `apps/desktop/src/process_util.rs`: a tiny trait extension that
//! hides the window on Windows and is a no-op everywhere else.
//!
//! Usage:
//! ```ignore
//! use crate::process_util::CommandNoWindow;
//! Command::new("git").no_window().args(["status"]).output()?;
//! ```

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait CommandNoWindow {
    /// Hide the spawned console window on Windows. No-op elsewhere.
    fn no_window(&mut self) -> &mut Self;
}

impl CommandNoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl CommandNoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
