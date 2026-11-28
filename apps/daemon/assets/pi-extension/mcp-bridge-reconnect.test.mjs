// Runs the real extension (through pi's jiti) against stub stdio MCP servers:
// - kills a server and checks that the next tool call reconnects instead of
//   failing with the SDK's "Not connected" for the rest of the host's life;
// - rewrites the effective MCP file (`TEAMCLU_MCP_CONFIG_PATH`) the way amuxd
//   does and checks that a server still listed stays connected while a new one
//   is bridged.
//
// It needs pi's installed node_modules (jiti + @modelcontextprotocol/sdk),
// which CI does not have, so it is not in ci.yml and skips without them. Run it
// locally after changing the MCP bridge:
//
//   node --test apps/daemon/assets/pi-extension/mcp-bridge-reconnect.test.mjs
//
// Point TEAMCLU_PI_NODE_MODULES at a pi install's node_modules to use one other
// than ~/.amuxd/cache/pi/node_modules.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeModules =
  process.env.TEAMCLU_PI_NODE_MODULES ?? path.join(os.homedir(), ".amuxd/cache/pi/node_modules");

function findJiti() {
  for (const from of [
    path.join(nodeModules, "@earendil-works/pi-coding-agent/package.json"),
    path.join(nodeModules, "package.json"),
  ]) {
    try {
      return createRequire(from)("jiti");
    } catch {}
  }
  return null;
}

const jitiModule = fs.existsSync(path.join(nodeModules, "@modelcontextprotocol/sdk")) ? findJiti() : null;

const STUB_SERVER = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "stub", version: "1.0.0" });
server.tool("whoami", "the server's pid", async () => ({
  content: [{ type: "text", text: String(process.pid) }],
}));
server.tool("crash", "exit the server", async () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [{ type: "text", text: "exiting" }] };
});
await server.connect(new StdioServerTransport());
`;

test(
  "an MCP server that exits is reconnected on the next tool call",
  { skip: jitiModule ? false : `pi node_modules not found at ${nodeModules}` },
  async () => {
    // The extension resolves the SDK by walking up from its own file, so it
    // runs from a temp dir with pi's node_modules linked in beside it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamclu-mcp-reconnect-"));
    fs.symlinkSync(nodeModules, path.join(dir, "node_modules"), "dir");
    fs.copyFileSync(path.join(here, "teamclu.ts"), path.join(dir, "teamclu.ts"));
    fs.writeFileSync(path.join(dir, "stub.mjs"), STUB_SERVER);

    process.env.TEAMCLU_MCP_SERVERS = JSON.stringify({
      stub: { type: "local", command: [process.execPath, path.join(dir, "stub.mjs")] },
    });
    delete process.env.TEAMCLU_MCP_CONFIG_PATH;
    delete process.env.TEAMCLU_MCP_TOOL_CACHE_DIR;

    const jiti = jitiModule.createJiti(import.meta.url);
    const extension = await jiti.import(path.join(dir, "teamclu.ts"));

    const tools = new Map();
    const pi = new Proxy(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { get: (target, key) => target[key] ?? (() => {}) },
    );
    await extension.default(pi);

    const call = async (suffix) => {
      const name = [...tools.keys()].find((n) => n.endsWith(suffix));
      assert.ok(name, `tool ${suffix} registered (have: ${[...tools.keys()].join(", ")})`);
      const result = await tools.get(name).execute("call", {}, undefined, undefined, { ui: {} });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.content[0].text;
    };

    try {
      const firstPid = await call("whoami");
      await call("crash");
      // Let the child exit and the transport report the close.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const secondPid = await call("whoami");
      assert.notEqual(secondPid, firstPid, "a new server process answered");
      assert.equal(await call("whoami"), secondPid, "the new connection is reused");
    } finally {
      await call("crash").catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "rewriting the effective MCP file keeps listed servers and bridges new ones",
  { skip: jitiModule ? false : `pi node_modules not found at ${nodeModules}` },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamclu-mcp-effective-"));
    fs.symlinkSync(nodeModules, path.join(dir, "node_modules"), "dir");
    fs.copyFileSync(path.join(here, "teamclu.ts"), path.join(dir, "teamclu.ts"));
    fs.writeFileSync(path.join(dir, "stub.mjs"), STUB_SERVER);

    const stub = { type: "local", command: [process.execPath, path.join(dir, "stub.mjs")] };
    const effective = path.join(dir, "ws", "mcp.effective.json");
    fs.mkdirSync(path.dirname(effective));
    const writeEffective = (mcp) =>
      fs.writeFileSync(effective, JSON.stringify({ workspace: "/ws", mcp }));
    writeEffective({ "teamclu-introspect": stub });
    process.env.TEAMCLU_MCP_SERVERS = JSON.stringify({ "teamclu-introspect": stub });
    process.env.TEAMCLU_MCP_CONFIG_PATH = effective;
    delete process.env.TEAMCLU_MCP_TOOL_CACHE_DIR;
    // A fresh module instance: the bridge registry and watcher live on globalThis.
    delete globalThis.__teamcluMcpBridges;
    delete globalThis.__teamcluMcpSdk;
    delete globalThis.__teamcluMcpToolOwners;
    delete globalThis.__teamcluMcpWatchState;

    const jiti = jitiModule.createJiti(import.meta.url, { moduleCache: false });
    const extension = await jiti.import(path.join(dir, "teamclu.ts"));
    const tools = new Map();
    const pi = new Proxy(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { get: (target, key) => target[key] ?? (() => {}) },
    );
    await extension.default(pi);
    const call = async (name) => {
      const result = await tools.get(name).execute("call", {}, undefined, undefined, { ui: {} });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.content[0].text;
    };
    const whoami = () => [...tools.keys()].find((n) => n.endsWith("whoami"));

    try {
      const firstName = whoami();
      const firstPid = await call(firstName);

      // amuxd rewrites the file with the same server plus a new one.
      writeEffective({ "teamclu-introspect": stub, "added-later": stub });
      const whoamis = () => [...tools.keys()].filter((n) => n.endsWith("whoami")).length;
      for (let i = 0; i < 40 && whoamis() < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await call(firstName), firstPid, "the listed server kept its connection");
      const added = [...tools.keys()].filter((n) => n.endsWith("whoami") && n !== firstName);
      assert.equal(added.length, 1, `new server bridged (have: ${[...tools.keys()].join(", ")})`);
      assert.notEqual(await call(added[0]), firstPid);
    } finally {
      for (const name of tools.keys()) {
        if (name.endsWith("crash")) await call(name).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a new session bridges from the effective file, not the host's spawn snapshot",
  { skip: jitiModule ? false : `pi node_modules not found at ${nodeModules}` },
  async () => {
    // #2059: amuxd keeps a live host when the MCP list changes and rewrites the
    // effective file instead. A session that starts on that host afterwards
    // must see the file's list; the spawn-time env would drop `added-later`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamclu-mcp-session-"));
    fs.symlinkSync(nodeModules, path.join(dir, "node_modules"), "dir");
    fs.copyFileSync(path.join(here, "teamclu.ts"), path.join(dir, "teamclu.ts"));
    fs.writeFileSync(path.join(dir, "stub.mjs"), STUB_SERVER);

    const stub = { type: "local", command: [process.execPath, path.join(dir, "stub.mjs")] };
    const effective = path.join(dir, "ws", "mcp.effective.json");
    fs.mkdirSync(path.dirname(effective));
    fs.writeFileSync(
      effective,
      JSON.stringify({ workspace: "/ws", mcp: { "teamclu-introspect": stub, "added-later": stub } }),
    );
    process.env.TEAMCLU_MCP_SERVERS = JSON.stringify({ "teamclu-introspect": stub });
    process.env.TEAMCLU_MCP_CONFIG_PATH = effective;
    delete process.env.TEAMCLU_MCP_TOOL_CACHE_DIR;
    delete globalThis.__teamcluMcpBridges;
    delete globalThis.__teamcluMcpSdk;
    delete globalThis.__teamcluMcpToolOwners;
    delete globalThis.__teamcluMcpWatchState;

    const jiti = jitiModule.createJiti(import.meta.url, { moduleCache: false });
    const extension = await jiti.import(path.join(dir, "teamclu.ts"));
    const tools = new Map();
    const pi = new Proxy(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { get: (target, key) => target[key] ?? (() => {}) },
    );
    const call = async (name) => {
      const result = await tools.get(name).execute("call", {}, undefined, undefined, { ui: {} });
      return result.content[0].text;
    };

    try {
      await extension.default(pi);
      const whoamis = [...tools.keys()].filter((n) => n.endsWith("whoami"));
      assert.equal(whoamis.length, 2, `both servers in the file are bridged (have: ${[...tools.keys()].join(", ")})`);
    } finally {
      for (const name of tools.keys()) {
        if (name.endsWith("crash")) await call(name).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
