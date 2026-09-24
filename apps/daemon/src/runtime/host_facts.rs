//! What is true of *this* machine, for the session prompt.
//!
//! Deliberately not app state. The same app is checked out on two macOS
//! machines and a Windows machine in one team here, and whichever teammate
//! deploys is the one whose tools run. A host fact stored on the app row would
//! be wrong for two thirds of them.
//!
//! The agent needs these to answer two questions it kept getting wrong: can I
//! build a container image here at all, and will the command I am about to
//! commit still work on someone else's machine.

use serde_json::{json, Value};

/// The shell a custom `build.command` is run under.
///
/// `sync::app_build` spawns `sh -c <command>` with no `target_os` branch, so on
/// Windows this needs a POSIX shell on PATH. Published rather than assumed: an
/// agent writing `rm -rf` has no other way to learn that.
const BUILD_SHELL: &str = "sh -c";

/// This machine, as the agent needs to see it.
pub fn host_facts() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "docker": docker_available(),
        "buildShell": BUILD_SHELL,
    })
}

/// Whether `docker` can be found, without paying to start it.
///
/// Four of the twelve fix commits on one app were Docker attempts on a machine
/// that had none; the failure only arrived after a build.
fn docker_available() -> bool {
    crate::runtime::well_known_bin::find_in_path("docker", None).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_facts_describe_this_machine_not_the_app() {
        let f = host_facts();
        // Whatever machine runs this test, these must be populated: the agent
        // reads them to decide whether a build command is even runnable here.
        assert!(f["os"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(f["arch"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(f["docker"].is_boolean());
        assert_eq!(f["buildShell"], "sh -c");
    }

    #[test]
    fn host_facts_name_the_real_os() {
        let f = host_facts();
        let os = f["os"].as_str().unwrap();
        assert!(
            ["macos", "windows", "linux"].contains(&os),
            "unexpected os {os}"
        );
    }
}
