import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile as fsWrite, readFile as fsRead, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pexec = promisify(execFile);

// `node --test` runs each test FILE in its own child process, so a per-process
// unique compose project name fully isolates scenarios that run in parallel:
// each gets its own container names, its own ephemeral host ports, and its own
// `/root/.amuxd`. Without this they all shared the `amuxd-oss-e2e` project +
// fixed container names/ports and collided ("container name already in use",
// duplicate `[http]` in a shared daemon.toml, port-in-use, before-hook
// timeouts). Set COMPOSE_PROJECT_NAME to pin a deterministic name for a single
// manual run.
const PROJECT =
  process.env.COMPOSE_PROJECT_NAME ||
  `amuxd-oss-e2e-${process.pid}-${randomUUID().slice(0, 8)}`;
const COMPOSE = ["docker", "compose", "-f", "docker-compose.yml", "-p", PROJECT];

/** The per-process compose project name all docker commands are scoped to. */
export function composeProject() {
  return PROJECT;
}

export function contentRootPath(teamId) {
  // v2 layout: sync scans teams/<id>/shared (knowledge/ lives directly under it).
  return `/root/.amuxd/teams/${teamId}/shared`;
}
export function syncStatePath(teamId) {
  return `/root/.amuxd/teams/${teamId}/sync/state.json`;
}

async function run(argv, opts = {}) {
  // cwd 固定到 harness 目录的上级（compose 文件所在），由调用方保证 process.cwd()。
  return pexec(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024, ...opts });
}

export async function composeUp(profiles = []) {
  const prof = profiles.flatMap((p) => ["--profile", p]);
  await run([...COMPOSE, ...prof, "up", "-d", "--wait"]);
}
export async function composeDown() {
  await run([...COMPOSE, "down", "-v"]);
}
export async function containerId(service) {
  const { stdout } = await run([...COMPOSE, "ps", "-q", service]);
  const id = stdout.trim();
  if (!id) throw new Error(`no container for service ${service}`);
  return id;
}

/**
 * Parse `docker compose port <svc> <port>` output into a host port number.
 * Compose prints `host:port` (e.g. `127.0.0.1:32769`), occasionally one line
 * per published mapping — take the last non-empty line and the trailing port.
 */
export function parsePublishedPort(stdout) {
  const line = String(stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (!line) throw new Error(`no published port in: ${JSON.stringify(stdout)}`);
  const port = Number(line.slice(line.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`bad published port: ${JSON.stringify(line)}`);
  }
  return port;
}

/**
 * Host port that maps to the service's in-container `containerPort` (8787 for
 * the daemon HTTP API). Call after `composeUp` — the compose file publishes an
 * ephemeral loopback port so parallel scenarios never fight over a fixed one.
 */
export async function publishedPort(service, containerPort = 8787) {
  const { stdout } = await run([...COMPOSE, "port", service, String(containerPort)]);
  return parsePublishedPort(stdout);
}

/** 在容器里跑 argv（不经 shell）；返回 {stdout, stderr}。 */
export async function exec(service, argv, opts = {}) {
  const id = await containerId(service);
  return run(["docker", "exec", id, ...argv], opts);
}
/** 在容器里跑一段 sh -c 脚本。 */
export async function execSh(service, script) {
  const id = await containerId(service);
  return run(["docker", "exec", id, "sh", "-c", script]);
}
/** 后台启动（detached）。 */
export async function execDetached(service, script) {
  const id = await containerId(service);
  return run(["docker", "exec", "-d", id, "sh", "-c", script]);
}

/** 把 bytes 写到容器内 absPath（二进制安全：docker cp）。 */
export async function writeFile(service, absPath, bytes) {
  const id = await containerId(service);
  const dir = absPath.slice(0, absPath.lastIndexOf("/"));
  await run(["docker", "exec", id, "mkdir", "-p", dir]);
  const tmp = await mkdtemp(join(tmpdir(), "amuxd-e2e-"));
  const local = join(tmp, "blob");
  await fsWrite(local, bytes);
  try {
    await run(["docker", "cp", local, `${id}:${absPath}`]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** 读容器内文件，返回 Buffer；不存在则返回 null。 */
export async function readFile(service, absPath) {
  const id = await containerId(service);
  const tmp = await mkdtemp(join(tmpdir(), "amuxd-e2e-"));
  const local = join(tmp, "blob");
  try {
    await run(["docker", "cp", `${id}:${absPath}`, local]);
    return await fsRead(local);
  } catch {
    return null;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * 列出 content root 下所有文件，返回 { relPath -> base64 内容 }。
 * 用于收敛断言。content root 不存在时返回 {}。
 */
export async function lsContentRoot(service, teamId) {
  const root = contentRootPath(teamId);
  let listing;
  try {
    const { stdout } = await execSh(
      service,
      `cd ${root} 2>/dev/null && find . -type f | sed 's|^\\./||' | sort || true`,
    );
    listing = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return {};
  }
  const out = {};
  for (const rel of listing) {
    const buf = await readFile(service, `${root}/${rel}`);
    out[rel] = buf ? buf.toString("base64") : "";
  }
  return out;
}
