//! `amuxd setup` — hand the browser a link to the running daemon's setup UI.
//!
//! Reads the two files `http::spawn` writes at startup: the actually-bound
//! port (`amuxd.http.port`, needed because the default bind is an ephemeral
//! `127.0.0.1:0`) and the 0600 root token (`amuxd.http.token`). Both are
//! readable only by the user who owns the daemon, so being able to run this
//! command *is* the authorization.
//!
//! The token rides in the query string. That is safe here in a way it would
//! not be on a public origin: the URL never leaves loopback, and the page
//! immediately exchanges the root token for a scoped session token.

use crate::config::DaemonConfig;

pub fn run(print_only: bool) -> anyhow::Result<()> {
    let port_path = DaemonConfig::http_port_path();
    let token_path = DaemonConfig::http_token_path();

    let port = std::fs::read_to_string(&port_path)
        .map_err(|e| {
            anyhow::anyhow!(
                "cannot read {} ({e}).\nIs the daemon running? Start it with `amuxd start`.",
                port_path.display()
            )
        })?
        .trim()
        .to_string();

    let token = std::fs::read_to_string(&token_path)
        .map_err(|e| anyhow::anyhow!("cannot read {} ({e})", token_path.display()))?
        .trim()
        .to_string();

    let url = format!("http://127.0.0.1:{port}/v1/setup?access_token={token}");

    if print_only {
        println!("{url}");
        return Ok(());
    }

    println!("Opening {url}");
    if let Err(e) = open_browser(&url) {
        // Not fatal: the URL above is the deliverable, the browser is a
        // convenience. Headless hosts hit this every time.
        eprintln!("could not open a browser ({e}); open the URL above manually");
    }
    Ok(())
}

fn open_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use crate::process_util::CommandNoWindow;
        let mut c = std::process::Command::new("cmd");
        c.no_window();
        c.args(["/C", "start", ""]);
        c
    };

    cmd.arg(url).status().map(|_| ())
}
