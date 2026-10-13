// Places teamclu-support next to the Tauri project so bundle.macOS.files can
// copy it into Contents/MacOS. Exits immediately off Darwin: the Windows
// installer uses its own copy of the helper, and this command also runs there.
//
// beforeBundleCommand runs after scripts/sign-macos-bundle-binaries.sh, so a
// helper copied here still has to be signed in this script.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(repo, "apps/desktop/binaries");
const dest = join(destDir, "teamclu-support");
const arch = process.env.TAURI_ENV_ARCH || "";
const platform = process.env.TAURI_ENV_PLATFORM || "";
let triple = process.env.TAURI_ENV_TARGET_TRIPLE || "";
if (!triple && platform === "darwin") {
  if (arch === "aarch64" || arch === "arm64") triple = "aarch64-apple-darwin";
  else if (arch === "x86_64") triple = "x86_64-apple-darwin";
}

function matchesArch(path) {
  if (!existsSync(path)) return false;
  if (!triple) return true;
  const info = execFileSync("file", ["-b", path], { encoding: "utf8" });
  if (triple.startsWith("aarch64")) return info.includes("arm64");
  if (triple.startsWith("x86_64")) return info.includes("x86_64");
  return true;
}

if (!matchesArch(dest)) {
  const manifest = join(repo, "apps/support-helper/Cargo.toml");
  const args = ["build", "--release", "--locked", "--manifest-path", manifest, "-p", "teamclu-support"];
  if (triple) args.push("--target", triple);
  execFileSync("cargo", args, { stdio: "inherit", cwd: repo });
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifest],
      { encoding: "utf8", cwd: repo },
    ),
  );
  const src = triple
    ? join(meta.target_directory, triple, "release", "teamclu-support")
    : join(meta.target_directory, "release", "teamclu-support");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
}

const identity = process.env.APPLE_SIGNING_IDENTITY || "";
if (identity) {
  execFileSync(
    "codesign",
    ["--force", "--options", "runtime", "--timestamp", "--sign", identity, dest],
    { stdio: "inherit" },
  );
}

if (!existsSync(dest)) {
  console.error("stage-macos-support-helper: teamclu-support was not produced");
  process.exit(1);
}
