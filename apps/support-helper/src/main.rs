#[cfg(any(windows, target_os = "macos"))]
mod flow;
#[cfg(any(windows, target_os = "macos"))]
mod gather;
mod http;
#[cfg(target_os = "macos")]
mod macui;
#[cfg(windows)]
mod winui;

use std::env;
use std::path::PathBuf;

fn parse_args() -> (String, String) {
    let mut phase = "manual".to_string();
    let mut api = option_env!("TEAMCLU_CLOUD_API_URL")
        .unwrap_or("")
        .to_string();
    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--phase=") {
            phase = value.to_string();
        } else if let Some(value) = arg.strip_prefix("--api-url=") {
            api = value.to_string();
        } else if arg == "--phase" {
            index += 1;
            if let Some(value) = args.get(index) {
                phase = value.clone();
            }
        } else if arg == "--api-url" {
            index += 1;
            if let Some(value) = args.get(index) {
                api = value.clone();
            }
        }
        index += 1;
    }
    if !matches!(phase.as_str(), "install" | "webview" | "manual") {
        phase = "manual".to_string();
    }
    (phase, api.trim().trim_end_matches('/').to_string())
}

fn journal_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    teamclu_support::collect::journal_path(&home)
}

fn main() {
    let (phase, api) = parse_args();
    #[cfg(windows)]
    {
        winui::run(&phase, &api, journal_path());
    }
    #[cfg(target_os = "macos")]
    {
        macui::run(&phase, &api, journal_path());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (phase, api);
        eprintln!(
            "teamclu-support 只在 Windows 和 macOS 上打开窗口。记录文件：{}",
            journal_path().display()
        );
        std::process::exit(1);
    }
}
