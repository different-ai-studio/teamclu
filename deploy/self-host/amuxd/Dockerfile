# syntax=docker/dockerfile:1
# Multi-stage build of the TeamClu daemon (amuxd) for the self-host stack.
# Build context MUST be the repo root (needs the Cargo workspace: crates/ +
# apps/daemon + Cargo.lock).
#
# Dependencies are compiled in their own layer with cargo-chef, keyed only on
# the workspace manifests + Cargo.lock (recipe.json). With `cache-to:
# type=gha,mode=max` in daemon-deploy.yml, a push that touches only amuxd's
# own sources reuses that layer instead of cold-building every crate (~11 min).
FROM rust:1-bookworm AS chef
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev cmake clang protobuf-compiler && rm -rf /var/lib/apt/lists/*
# rustup honours rust-toolchain.toml, so copy it first: cargo-chef, the
# dependency layer and the final build all then use the pinned compiler.
COPY rust-toolchain.toml ./
RUN cargo install cargo-chef --locked
ENV CARGO_TARGET_DIR=/out

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS build
COPY --from=planner /src/recipe.json recipe.json
# [patch.crates-io] points at vendored crates (rumqttc, …); the recipe only
# carries manifests, so the patched sources have to be present for cook.
COPY vendor ./vendor
RUN cargo chef cook --release -p amuxd --recipe-path recipe.json
COPY . .
RUN cargo build --release -p amuxd --bin amuxd

FROM debian:bookworm-slim AS runtime
# ca-certificates: TLS to cloud API / LLM provider. curl: smoke health probe.
# git: per-app Gitea checkouts (apps/daemon/src/sync/app_git.rs).
# The agent runtime (pi on a managed Node) is installed by amuxd itself at
# runtime into $HOME/.amuxd/cache (node_install / pi_install), so nothing
# runtime-specific is baked into the image (ADR-0014, ADR-0015).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/release/amuxd /usr/local/bin/amuxd
# Daemon state (backend.toml / daemon.toml) lives under $HOME/.amuxd.
# /state is a named volume so identity persists across restarts.
ENV HOME=/state
WORKDIR /state
# entrypoint.sh is mounted by docker-compose (the repo-root .dockerignore
# excludes deploy/, so it cannot be COPY'd into the build context). The compose
# service overrides entrypoint to: ["/bin/sh", "/entrypoint.sh"].
CMD ["amuxd", "start"]
