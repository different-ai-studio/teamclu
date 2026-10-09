"use strict";

const path = require("path");

/**
 * Target directory for a sidecar build — deliberately NOT the shared one.
 *
 * The sidecars and the desktop crate are members of one cargo workspace, but
 * each `-p <pkg>` invocation resolves shared dependencies on its own. Measured
 * on `reqwest v0.12`, three different feature sets come out of the three builds
 * this repo runs:
 *
 *   -p amuxd             rustls only
 *   -p teamclu           + default-tls, charset, h2, http2, system-proxy
 *                        (pulled in by serenity)
 *   -p teamclu-introspect  default-tls path, no rustls at all
 *
 * Pointed at one CARGO_TARGET_DIR they invalidate each other's reqwest subtree,
 * which cascades through hyper → teamclu-gateway → teamclu_lib → a relink of the
 * whole binary. One such flip measured ~13 minutes. Aligning the features is not
 * an option: the extra ones come from third-party crates, not our manifests.
 *
 * Cost of the split: each sidecar's dependency tree is compiled once more on
 * disk.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} fallbackDir used when CARGO_TARGET_DIR is unset
 * @param {string} name sidecar package name, e.g. "amuxd"
 */
function sidecarTargetDir(env, fallbackDir, name) {
  const base = env.CARGO_TARGET_DIR || path.join(fallbackDir, "target");
  return path.join(base, `sidecar-${name}`);
}

module.exports = { sidecarTargetDir };
