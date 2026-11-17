//! Link the MSVC VC runtime statically so the sidecar starts on a Windows
//! install without the Visual C++ Redistributable (no VCRUNTIME140.dll). See
//! the build-dependency comment in Cargo.toml. No-op off MSVC.

fn main() {
    static_vcruntime::metabuild();
}
