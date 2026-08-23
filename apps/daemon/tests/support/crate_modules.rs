// Pasted at the integration-test crate root via `include!`.
// Paths are relative to this file (`tests/support/crate_modules.rs`).

#[path = "../../src/backend/mod.rs"]
mod backend;
#[path = "../../src/claude_install/mod.rs"]
mod claude_install;
#[path = "../../src/config/mod.rs"]
mod config;
#[path = "../../src/cursor_install/mod.rs"]
mod cursor_install;
// `http::server` reports this machine's id on /v1/info; an integration test's
// crate root only has the modules it declares here.
#[path = "../../src/device_id.rs"]
mod device_id;
#[path = "../../src/error.rs"]
mod error;
#[path = "../../src/http/mod.rs"]
mod http;
#[path = "../../src/mcp_probe.rs"]
mod mcp_probe;
#[path = "../../src/mqtt/mod.rs"]
mod mqtt;
#[path = "../../src/opencode_install/mod.rs"]
mod opencode_install;
#[path = "../../src/opencode_settings/mod.rs"]
mod opencode_settings;
#[path = "../../src/pi_install/mod.rs"]
mod pi_install;
// Spawning helper introduced by #1045. Only the bin crate root declared it, so
// every src module that reached for `crate::process_util::CommandNoWindow`
// failed to resolve here — the same E0433/E0432 shape the note below covers.
#[path = "../../src/process_util.rs"]
mod process_util;
#[path = "../../src/proto.rs"]
mod proto;
#[path = "../../src/provider_config.rs"]
mod provider_config;
// Same rule as `process_util` above: `opencode_install` and `pi_install` both
// reach for `crate::route_probe`, and an integration-test crate root only has
// what it declares here.
#[path = "../../src/route_probe.rs"]
mod route_probe;
#[path = "../../src/runtime/mod.rs"]
mod runtime;
#[path = "../../src/sync/mod.rs"]
mod sync;
#[path = "../../src/team_link.rs"]
mod team_link;
#[path = "../../src/team_shared_env.rs"]
mod team_shared_env;
// Not used by the tests in this crate directly. The modules above carry their
// own `#[cfg(test)]` blocks, which an integration-test crate *does* compile,
// and those name `crate::test_brand_env` — which resolves against THIS root,
// not the bin's. Without it `cargo test -p amuxd` fails to build with E0433.
#[path = "../../src/test_brand_env.rs"]
mod test_brand_env;

fn test_sync_dispatcher() -> sync::dispatch::SyncDispatcher {
    sync::dispatch::SyncDispatcher::new(sync::secret_store::SecretStore::new(), None)
}
