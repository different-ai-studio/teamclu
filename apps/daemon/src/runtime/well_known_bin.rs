//! Re-export of the shared binary-path resolver.
//!
//! The implementation moved to the `teamclu-binpath` crate so `apps/desktop`
//! could stop keeping a second, weaker copy of the same lookup (#1049). This
//! module stays as the daemon's existing path to it — every
//! `crate::runtime::well_known_bin::…` call site still resolves — and holds no
//! logic of its own. Anything new belongs in the crate, not here.
pub use teamclu_binpath::*;
