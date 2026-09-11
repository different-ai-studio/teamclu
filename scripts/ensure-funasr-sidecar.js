#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { installSidecarIfChanged } = require("./lib/install-sidecar-atomic");

const FUNASR_VERSION = "1.4.15";
const LLAMA_COMMIT = "803b7fcae893e9caaee3921779628fef83ac0965";
const SIDECAR_BUILD_REVISION = 2;
const FUNASR_SOURCE = {
  url: `https://github.com/modelscope/FunASR/archive/refs/tags/v${FUNASR_VERSION}.tar.gz`,
  sha256: "a4f65dd903a24b710af9efbe017a57e07e970824049c748e2c7c0d5bc4ae4b40",
};
const LLAMA_SOURCE = {
  url: `https://github.com/ggml-org/llama.cpp/archive/${LLAMA_COMMIT}.tar.gz`,
  sha256: "8fe8528e89d8fca8c8b81696efa83ff82c996bf84d17be65e884c1ceae35351e",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}`);
  }
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function downloadChecked(spec, destination) {
  run("curl", [
    "-fsSL",
    "--retry",
    "3",
    "--connect-timeout",
    "30",
    "--max-time",
    "300",
    spec.url,
    "-o",
    destination,
  ]);
  const actual = sha256(destination);
  if (actual !== spec.sha256) {
    throw new Error(`checksum mismatch for ${spec.url}: ${actual}`);
  }
}

function hostTarget(env) {
  if (env.TARGET) return env.TARGET;
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8", env });
  return result.stdout?.match(/host:\s*(\S+)/)?.[1] ?? "";
}

function planForTarget(target) {
  if (target === "aarch64-apple-darwin") return "build-arm64";
  if (target === "x86_64-apple-darwin") return "build-intel";
  return null;
}

function binaryMatchesTarget(binary, target, env) {
  if (!fs.existsSync(binary)) return false;
  const result = spawnSync("file", [binary], { encoding: "utf8", env });
  if (result.status !== 0) return false;
  const expected = target.startsWith("aarch64") ? "arm64" : "x86_64";
  return result.stdout.includes("Mach-O") && result.stdout.includes(expected);
}

function prepareFromSource(tempDir, target, env) {
  const funasrArchive = path.join(tempDir, "funasr.tar.gz");
  const llamaArchive = path.join(tempDir, "llama.tar.gz");
  downloadChecked(FUNASR_SOURCE, funasrArchive);
  downloadChecked(LLAMA_SOURCE, llamaArchive);
  run("tar", ["-xzf", funasrArchive, "-C", tempDir]);
  run("tar", ["-xzf", llamaArchive, "-C", tempDir]);

  const source = path.join(tempDir, `FunASR-${FUNASR_VERSION}`, "runtime", "llama.cpp");
  const llama = path.join(tempDir, `llama.cpp-${LLAMA_COMMIT}`);
  const build = path.join(tempDir, "build");
  const architecture = target.startsWith("aarch64") ? "arm64" : "x86_64";
  const deploymentTarget = architecture === "arm64" ? "11.0" : "10.15";
  const cpuOptions =
    architecture === "x86_64"
      ? ["-DGGML_AVX=ON", "-DGGML_AVX2=OFF", "-DGGML_FMA=OFF", "-DGGML_BMI2=OFF"]
      : [];
  run(
    "cmake",
    [
      "-S",
      source,
      "-B",
      build,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_OSX_ARCHITECTURES=${architecture}`,
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${deploymentTarget}`,
      "-DGGML_NATIVE=OFF",
      "-DGGML_METAL=OFF",
      "-DGGML_BLAS=OFF",
      "-DLLAMA_CURL=OFF",
      ...cpuOptions,
      `-DFETCHCONTENT_SOURCE_DIR_LLAMA=${llama}`,
    ],
    { env },
  );
  run(
    "cmake",
    [
      "--build",
      build,
      "--config",
      "Release",
      "--parallel",
      String(Math.max(1, Math.min(8, os.cpus().length))),
      "--target",
      "llama-funasr-sensevoice",
    ],
    { env },
  );
  return path.join(build, "bin", "llama-funasr-sensevoice");
}

function ensureFunASRSidecar(env = process.env, opts = {}) {
  if (process.platform !== "darwin" || (env.CI === "1" && !opts.target)) return;
  const target = opts.target || hostTarget(env);
  const plan = planForTarget(target);
  if (!plan) return;

  const repoRoot = path.resolve(__dirname, "..");
  const destination = path.join(
    repoRoot,
    "apps",
    "desktop",
    "binaries",
    `llama-funasr-sensevoice-${target}`,
  );
  const stampPath = `${destination}.source.json`;
  const expectedStamp = JSON.stringify({
    version: FUNASR_VERSION,
    llama: LLAMA_COMMIT,
    plan,
    buildRevision: SIDECAR_BUILD_REVISION,
  });
  const currentStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8") : "";
  if (!opts.force && currentStamp === expectedStamp && binaryMatchesTarget(destination, target, env)) {
    return;
  }

  const logPrefix = opts.logPrefix ?? "[funasr-sidecar]";
  console.log(`${logPrefix} Preparing FunASR ${FUNASR_VERSION} for ${target}...`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamclu-funasr-"));
  try {
    const built = prepareFromSource(tempDir, target, env);
    if (!binaryMatchesTarget(built, target, env)) {
      throw new Error(`FunASR build does not match target ${target}`);
    }
    fs.chmodSync(built, 0o755);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    installSidecarIfChanged(built, destination);
    fs.writeFileSync(stampPath, expectedStamp);
    console.log(`${logPrefix} Installed ${destination}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
  try {
    ensureFunASRSidecar(process.env, {
      target,
      force: process.argv.includes("--force"),
    });
  } catch (error) {
    console.error(`[funasr-sidecar] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  FUNASR_VERSION,
  LLAMA_COMMIT,
  ensureFunASRSidecar,
  planForTarget,
};
