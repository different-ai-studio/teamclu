//! Environment variables and personal secrets for a workspace.
//!
//! Three things share this module, and the split follows them:
//!
//! | module        | holds                                                   |
//! |---------------|---------------------------------------------------------|
//! | `blob`        | the encrypted personal secret store and its migration   |
//! | `index`       | `teamclu.json` and the key/scope index (never values)   |
//! | `catalog`     | the Tauri commands the settings UI calls                |
//! | `system`      | product-defined variables and the ensure pass           |
//! | `diagnostics` | what the diagnostics panel reports about env storage    |

mod blob;
mod catalog;
mod diagnostics;
mod index;
mod system;

#[cfg(test)]
mod tests;

// Glob, not a named list: `#[tauri::command]` also emits a hidden `__cmd__<name>`
// macro beside each command, and `generate_handler!` resolves it through this
// path. A named re-export would leave those macros behind.
pub(crate) use blob::*;
pub use catalog::*;
pub use diagnostics::*;
pub use index::*;
pub(crate) use system::*;
