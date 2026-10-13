use std::path::Path;

fn quoted_after(text: &str, key: &str) -> Option<String> {
    let index = text.find(key)?;
    let rest = &text[index + key.len()..];
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')?;
    Some(rest[start..start + end].to_string())
}

fn main() {
    println!("cargo:rerun-if-env-changed=TEAMCLU_CLOUD_API_URL");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let config_path = manifest.join("../../build.config.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    let version_path = manifest.join("../desktop/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", version_path.display());

    let api = std::env::var("TEAMCLU_CLOUD_API_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let text = std::fs::read_to_string(&config_path).ok()?;
            quoted_after(&text, "\"cloudApiUrl\"")
        });
    if let Some(api) = api {
        println!("cargo:rustc-env=TEAMCLU_CLOUD_API_URL={api}");
    }

    let version = std::fs::read_to_string(&version_path)
        .ok()
        .and_then(|text| quoted_after(&text, "\"version\""))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=TEAMCLU_SUPPORT_VERSION={version}");
}
