import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function writeInstalledPlugin(dir) {
  const pluginDir = path.join(dir, ".opencode", "plugins");
  await fs.mkdir(pluginDir, { recursive: true });

  const clientSrc = path.join(repoRoot, "apps/daemon/shared/session-context-client.mjs");
  const pluginSrc = path.join(
    repoRoot,
    "packages/app/src/lib/opencode/templates/teamclu-session-context-plugin.mjs.txt",
  );

  const clientDest = path.join(pluginDir, "teamclu-session-context-client.mjs");
  const pluginDest = path.join(pluginDir, "teamclu-session-context.mjs");

  await fs.copyFile(clientSrc, clientDest);
  await fs.copyFile(pluginSrc, pluginDest);

  return { clientDest, pluginDest };
}

test("installed OpenCode plugin loads shared client and injects OpenCode tool ids", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclu-session-context-"));
  try {
    const { pluginDest } = await writeInstalledPlugin(dir);

    const pluginText = await fs.readFile(pluginDest, "utf8");
    assert.match(pluginText, /teamclu-session-context-client\.mjs/);

    const mod = await import(pathToFileURL(pluginDest).href);
    const factory = mod.TeamcluSessionContextPlugin ?? mod.default;
    assert.equal(typeof factory, "function");

    const hooks = await factory();
    assert.equal(typeof hooks["tool.execute.before"], "function");

    const originalArgs = { scheme: "copilot361" };
    const output = { args: originalArgs };
    await hooks["tool.execute.before"](
      {
        tool: "teamclu-introspect_get_session_deeplink",
        sessionID: "backend-a",
        callID: "call-a",
      },
      output,
      {
        injectSessionIdForTool: async () => ({
          scheme: "copilot361",
          session_id: "teamclu-a",
        }),
      },
    );
    assert.equal(originalArgs.session_id, "teamclu-a");
    assert.equal(output.args, originalArgs);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("plugin install overwrites stale shared client on upgrade", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclu-session-context-"));
  try {
    const { clientDest } = await writeInstalledPlugin(dir);
    await fs.writeFile(clientDest, "// stale client\nexport function handleToolExecuteBefore() {}\n");

    const clientSrc = path.join(repoRoot, "apps/daemon/shared/session-context-client.mjs");
    await fs.copyFile(clientSrc, clientDest);

    const upgraded = await fs.readFile(clientDest, "utf8");
    assert.match(upgraded, /normalizeSessionScopedToolName/);
    assert.doesNotMatch(upgraded, /stale client/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
