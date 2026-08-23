/**
 * TeamClu pi extension — permission gate + amuxd remote-tools MCP bridge.
 *
 * Shipped inside amuxd (include_str!), materialized to
 * `~/.amuxd/pi/extensions/teamclu.ts` at pi spawn and loaded via `-e <path>`.
 *
 * ## Env contract (set by amuxd `pi_rpc/process.rs` at spawn)
 *
 * - `TEAMCLU_PI_PERMISSIONS_FILE` — absolute path to a JSON rules file:
 *       { "defaultAction": "ask" | "allow", "alwaysAllowed": ["ls *", "edit", ...] }
 *   Re-read on every tool call (the daemon appends patterns to it when the
 *   host approves a permission with option_id "always"). Missing or invalid
 *   file ⇒ { defaultAction: "ask", alwaysAllowed: [] }.
 *   Pattern semantics: for `bash` the match key is the command string, for
 *   every other tool it is the tool name. A pattern ending in " *" is a
 *   prefix match on the first word(s); otherwise exact string equality.
 *
 * - `TEAMCLU_REMOTE_TOOLS_CMD` — JSON array, e.g.
 *       ["/path/to/amuxd", "remote-tools-mcp", "--sock=/path/amuxd.sock"]
 *   A stdio MCP server. When set, the extension connects to it, lists its
 *   tools, and registers each as a pi tool proxying tools/call. Unset ⇒ no
 *   bridge.
 *
 * - `TEAMCLU_MCP_SERVERS` — JSON object of the workspace's other MCP servers,
 *   normalized by `pi_server_spec` (`pi_rpc/mod.rs`) into the two shapes
 *   opencode understands:
 *       { "<name>": { "type": "local",  "command": [...], "environment": {…} } }
 *       { "<name>": { "type": "remote", "url": "…",       "headers": {…} } }
 *
 * - `TEAMCLU_MCP_CONFIG_PATH` — the `opencode.json` that payload came from,
 *   watched so an edit re-bridges without restarting pi.
 *
 * - `TEAMCLU_MCP_TOOL_CACHE_DIR` — where each server's `tools/list` result is
 *   cached, so session startup does not wait on a cold connection.
 *
 * ## MCP
 *
 * pi has no MCP of its own. This extension is the MCP client, built on the
 * official `@modelcontextprotocol/sdk`, which `amuxd pi install` installs into
 * this file's directory (`pi_install::mcp_sdk`). Local (stdio) and remote
 * (streamable HTTP, falling back to SSE) servers are both supported, matching
 * what opencode loads natively.
 *
 * ## Permission flow
 *
 * `tool_call` hook: on "ask" the extension calls `ctx.ui.confirm(title, message)`.
 * In `pi --mode rpc` that surfaces as `extension_ui_request{method:"confirm"}`
 * which amuxd translates into an AcpPermissionRequest. The message carries a
 * machine-readable trailer line `teamclu.always-pattern=<pattern>`; when the
 * host approves with "always", the daemon appends that pattern to the rules
 * file (the dialog reply itself only carries a confirmed boolean).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Loose ExtensionAPI typing: the real types live in
// @earendil-works/pi-coding-agent, which is not a dependency of this directory
// (only @modelcontextprotocol/sdk is) — runtime shape is what matters.
/** What pi accepts back from a tool: `AgentToolResult.content` is
 *  `(TextContent | ImageContent)[]`. */
type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolCallEvent = {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
};
type ExtensionContext = {
  ui: {
    confirm(title: string, message?: string, options?: { timeout?: number }): Promise<boolean>;
    select(
      title: string,
      options: string[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ): Promise<string | undefined>;
  };
};
type ExtensionAPI = {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ) => Promise<{ block: boolean; reason?: string } | undefined>,
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      // pi's real signature continues (onUpdate, ctx); the question tool needs
      // ctx.ui, the MCP proxies ignore both.
      onUpdate?: unknown,
      ctx?: ExtensionContext,
    ): Promise<{ content: PiToolContent[]; isError?: boolean }>;
  }): void;
  registerProvider(id: string, config: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

interface Rules {
  defaultAction: "ask" | "allow";
  alwaysAllowed: string[];
}

function loadRules(): Rules {
  const fallback: Rules = { defaultAction: "ask", alwaysAllowed: [] };
  const path = process.env.TEAMCLU_PI_PERMISSIONS_FILE;
  if (!path) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    return {
      defaultAction: parsed.defaultAction === "allow" ? "allow" : "ask",
      alwaysAllowed: Array.isArray(parsed.alwaysAllowed)
        ? parsed.alwaysAllowed.filter((p: unknown) => typeof p === "string")
        : [],
    };
  } catch {
    return fallback; // missing/corrupt file: fail closed to "ask"
  }
}

/** Match key: bash → the command string; other tools → the tool name. */
function matchKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") return input.command.trim();
  return toolName;
}

/** Persisted "always allow" pattern for this call (what the daemon appends). */
function alwaysPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") {
    const first = input.command.trim().split(/\s+/)[0] ?? "";
    return first ? `${first} *` : "bash";
  }
  return toolName;
}

/** "ls *" prefix-matches "ls -la"; a pattern without "*" is exact equality. */
function patternMatches(pattern: string, key: string): boolean {
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2);
    return key === prefix || key.startsWith(prefix + " ");
  }
  if (pattern === "*") return true;
  return pattern === key;
}

/** One-line summary for the confirm dialog title. */
function summarize(toolName: string, input: Record<string, unknown>): string {
  const candidates = ["command", "path", "file_path", "url", "pattern"];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v.split("\n")[0].slice(0, 120);
  }
  const json = JSON.stringify(input) ?? "{}";
  return json.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Team shared LLM provider
// ---------------------------------------------------------------------------

/**
 * Register the team's shared LLM gateway as a pi provider, mirroring how
 * opencode gets `provider.team`. amuxd sets `TEAMCLU_TEAM_PROVIDER` (from the
 * cloud-resolved managed LLM) to a JSON payload:
 *   { name, baseUrl, apiKeyEnv, models: [{ id, name }] }
 * The secret is never embedded — `apiKeyEnv` names an env var (`tc_api_key`,
 * derived from actor_id, already injected by amuxd) that pi interpolates via
 * `${...}`, the same key opencode uses. Absent/invalid env ⇒ no-op.
 */
function registerTeamProvider(pi: ExtensionAPI): void {
  const raw = process.env.TEAMCLU_TEAM_PROVIDER;
  if (!raw) return;
  let cfg: {
    name?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    models?: Array<{ id?: string; name?: string }>;
  };
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`[teamclu] invalid TEAMCLU_TEAM_PROVIDER: ${e}`);
    return;
  }
  if (!cfg.baseUrl || !Array.isArray(cfg.models) || cfg.models.length === 0) return;
  const apiKeyEnv = cfg.apiKeyEnv || "tc_api_key";
  const models = cfg.models
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id as string,
      name: m.name || (m.id as string),
      reasoning: false,
      input: ["text"] as string[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 16000,
    }));
  if (models.length === 0) return;
  try {
    pi.registerProvider("team", {
      name: cfg.name || "Team",
      baseUrl: cfg.baseUrl,
      apiKey: `\${${apiKeyEnv}}`,
      api: "openai-completions",
      models,
    });
  } catch (e) {
    console.error(`[teamclu] registerProvider(team) failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// MCP client (official @modelcontextprotocol/sdk)
// ---------------------------------------------------------------------------

/**
 * pi ships no MCP client — "**No MCP.** … or build an extension that adds MCP
 * support" (pi's README). This section is that client: it connects to every
 * server the workspace configures and republishes their tools as pi tools, so
 * a workspace presents the same tool set on pi as it does on opencode.
 *
 * The SDK is installed next to this file by `amuxd pi install`
 * (`pi_install::mcp_sdk`); pi resolves the bare import from
 * `<cache>/pi/extensions/node_modules`. The import is dynamic and guarded on
 * purpose: a missing SDK must cost MCP tools only, not the permission gate and
 * the question tool that share this extension and have nothing to do with MCP.
 */
type Sdk = {
  Client: any;
  StdioClientTransport: any;
  StreamableHTTPClientTransport: any;
  SSEClientTransport: any;
  ToolListChangedNotificationSchema: any;
};

const SDK_STATE: { promise: Promise<Sdk | null> | null } = ((globalThis as any).__teamcluMcpSdk ??= {
  promise: null,
});

function loadSdk(): Promise<Sdk | null> {
  SDK_STATE.promise ??= (async () => {
    try {
      const [client, stdio, streamable, sse, types] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/client/sse.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
      return {
        Client: (client as any).Client,
        StdioClientTransport: (stdio as any).StdioClientTransport,
        StreamableHTTPClientTransport: (streamable as any).StreamableHTTPClientTransport,
        SSEClientTransport: (sse as any).SSEClientTransport,
        ToolListChangedNotificationSchema: (types as any).ToolListChangedNotificationSchema,
      };
    } catch (e) {
      console.error(
        "[teamclu] @modelcontextprotocol/sdk is not resolvable next to this extension; " +
          `MCP tools are unavailable. Run \`amuxd pi install\` to repair. (${e})`,
      );
      return null;
    }
  })();
  return SDK_STATE.promise as Promise<Sdk | null>;
}

/** `${VAR}` / `$VAR` against the pi process env (which amuxd populated with
 *  team/personal secrets). Used for a local server's `environment` and for a
 *  remote server's `headers`, which carry tokens the same way. */
function resolveVars(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
      const name = a || b;
      return process.env[name] ?? "";
    });
  }
  return out;
}

/**
 * The environment a stdio server is spawned with.
 *
 * The SDK defaults to `getDefaultEnvironment()` — a small allow-list — where
 * this extension previously spawned children with the full `process.env`. That
 * difference is not cosmetic: amuxd injects the team API key, provider
 * credentials and an enriched PATH into pi's environment, and every one of
 * them would vanish from MCP servers under the SDK default.
 */
function childEnv(environment: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return { ...out, ...resolveVars(environment) };
}

type LocalServerSpec = {
  type?: "local";
  command: string[];
  environment?: Record<string, unknown>;
};
type RemoteServerSpec = {
  type: "remote";
  url: string;
  headers?: Record<string, unknown>;
};
type McpServerSpec = LocalServerSpec | RemoteServerSpec;

function isRemote(spec: McpServerSpec): spec is RemoteServerSpec {
  return (spec as RemoteServerSpec).type === "remote";
}

type McpTool = { name: string; description?: string; inputSchema?: unknown };

/** Cap on `tools/list` pages, so a server that always returns a cursor cannot
 *  hang session startup. */
const MAX_TOOL_PAGES = 50;

/** One connected MCP server. */
class McpBridge {
  private constructor(
    readonly client: any,
    readonly label: string,
  ) {}

  static async connect(label: string, spec: McpServerSpec, sdk: Sdk): Promise<McpBridge> {
    const make = () =>
      new sdk.Client({ name: "teamclu-pi-extension", version: "1.0.0" }, { capabilities: {} });
    if (isRemote(spec)) {
      const url = new URL(spec.url);
      const requestInit = { headers: resolveVars(spec.headers) };
      try {
        const client = make();
        await client.connect(new sdk.StreamableHTTPClientTransport(url, { requestInit }));
        return new McpBridge(client, label);
      } catch (e) {
        // Servers that only speak the older HTTP+SSE transport reject the
        // streamable POST. A fresh Client per attempt: one whose connect threw
        // already holds a dead transport.
        const client = make();
        await client.connect(new sdk.SSEClientTransport(url, { requestInit }));
        console.error(`[teamclu] MCP ${label}: streamable HTTP failed, using SSE (${e})`);
        return new McpBridge(client, label);
      }
    }
    const [command, ...args] = spec.command;
    const client = make();
    await client.connect(
      new sdk.StdioClientTransport({
        command,
        args,
        env: childEnv(spec.environment),
        // The server's own stderr belongs in pi's, which amuxd captures.
        stderr: "inherit",
      }),
    );
    return new McpBridge(client, label);
  }

  /** Every tool, following `nextCursor`. Servers with more tools than one page
   *  used to silently expose only the first page. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {});
      for (const tool of result?.tools ?? []) {
        if (tool && typeof tool.name === "string") tools.push(tool);
      }
      cursor = result?.nextCursor;
      if (!cursor) return tools;
    }
    console.error(`[teamclu] MCP ${this.label}: stopped paginating tools after ${MAX_TOOL_PAGES} pages`);
    return tools;
  }

  onToolListChanged(sdk: Sdk, handler: () => void): void {
    try {
      this.client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, () => handler());
    } catch (e) {
      // A server that never sends the notification is normal; a client that
      // cannot register the handler is not fatal either.
      console.error(`[teamclu] MCP ${this.label}: tools/list_changed handler unavailable (${e})`);
    }
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    return this.client.callTool({ name, arguments: args ?? {} }, undefined, {
      signal,
      // A tool that reports progress is working, not stuck.
      resetTimeoutOnProgress: true,
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Already gone: nothing to do.
    }
  }
}

/** MCP tool result → pi tool result content. */
function toPiContent(result: any): PiToolContent[] {
  const out: PiToolContent[] = [];
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      // pi accepts image content in tool results and normalizes oversized ones
      // (`normalizeToolResultImages`, which names MCP bridges as a source).
      // Stringifying these — what this bridge used to do — turned a screenshot
      // into a wall of base64 JSON.
      out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" });
    } else if (part.type === "resource" && typeof part.resource?.text === "string") {
      out.push({ type: "text", text: part.resource.text });
    } else {
      out.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  if (out.length === 0 && result?.structuredContent !== undefined) {
    out.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  if (out.length === 0) out.push({ type: "text", text: JSON.stringify(result ?? null) });
  return out;
}

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

/** Names the model is allowed to call: providers reject anything else, and pi
 *  keys its tool registry by name. */
function sanitizeToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return safe.length > 0 ? safe : "tool";
}

/** Which `<label>:<tool>` currently owns a registered name. Process-wide for
 *  the same reason the bridge registry is: pi re-runs this extension's entry
 *  point per session, and a name must resolve to the same server every time. */
const TOOL_OWNERS: Map<string, string> = ((globalThis as any).__teamcluMcpToolOwners ??= new Map());

/**
 * The name a server's tool is registered under.
 *
 * Identity for the common case — `browser_click` stays `browser_click`, so
 * skills and prompts that name a tool keep working. Only an actual clash with
 * a different server takes the qualified name, and the first claimant is never
 * renamed, which keeps the outcome independent of registration order.
 */
function registeredName(label: string, original: string): string {
  const owner = `${label}:${original}`;
  const base = sanitizeToolName(original);
  const held = TOOL_OWNERS.get(base);
  if (held === undefined || held === owner) {
    TOOL_OWNERS.set(base, owner);
    return base;
  }
  for (const candidate of [
    sanitizeToolName(`${label}_${original}`),
    ...Array.from({ length: 8 }, (_, i) => sanitizeToolName(`${label}_${original}_${i + 2}`)),
  ]) {
    const owned = TOOL_OWNERS.get(candidate);
    if (owned === undefined || owned === owner) {
      TOOL_OWNERS.set(candidate, owner);
      return candidate;
    }
  }
  console.error(`[teamclu] MCP ${label}: cannot find a free name for tool ${original}`);
  return base;
}

/** Give up the names a server held, so a renamed or removed server does not
 *  keep pushing its replacement into a qualified name forever. */
function releaseToolNames(label: string): void {
  const prefix = `${label}:`;
  for (const [name, owner] of [...TOOL_OWNERS]) {
    if (owner.startsWith(prefix)) TOOL_OWNERS.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Bridge registry
// ---------------------------------------------------------------------------

/**
 * Process-wide MCP bridge registry.
 *
 * # Why this is global rather than per-extension-instance
 *
 * pi runs this extension's entry point again for every new session, on the SAME
 * process. Each run used to spawn a fresh child for every configured server and
 * leave the previous ones running: a live process tree showed one `pi` with two
 * complete sets of MCP children, and a third session would have added a third.
 *
 * The cost was the whole of the "first message is slow" complaint. Measured on
 * this machine, `new_session` scaled linearly with the number of npx-based
 * servers — ~4s each, serially:
 *
 *   0 npx servers →   ~50ms
 *   1 npx server  →  ~4100ms
 *   3 npx servers → ~11000ms
 *
 * Keyed on `globalThis` rather than a module-level `const` because a re-import
 * would give the module fresh state, and re-import is exactly the case this has
 * to survive.
 */
type BridgeEntry = {
  /** Resolves once the client has completed the MCP handshake. Held as a
   *  promise, not a value, because a cache hit registers tools before the
   *  connection is even attempted. */
  ready: Promise<McpBridge>;
  /** The spec that produced this bridge; a change means reconnect. */
  signature: string;
  tools: McpTool[];
  /** `tools` came from the on-disk cache and no live `tools/list` has
   *  confirmed it yet. */
  provisional: boolean;
};

const BRIDGE_REGISTRY: Map<string, BridgeEntry> = ((globalThis as any).__teamcluMcpBridges ??=
  new Map());

function bridgeSignature(spec: McpServerSpec): string {
  return isRemote(spec)
    ? JSON.stringify(["remote", spec.url, spec.headers ?? {}])
    : JSON.stringify(["local", spec.command, spec.environment ?? {}]);
}

// ---------------------------------------------------------------------------
// tools/list cache
// ---------------------------------------------------------------------------

/**
 * Why this cache exists.
 *
 * pi cannot start a session until the extension's entry point returns, and the
 * entry point cannot register a server's tools until `tools/list` answers —
 * which means connecting first. Timed inside pi on this machine, that is where
 * the cold first message goes:
 *
 *   pi boot -> extension loaded    1.05s
 *   remote-tools bridge            0.03s
 *   teamclu-introspect bridge      0.03s
 *   playwright bridge              1.94s
 *   chrome-control bridge          2.14s
 *   autoui bridge                  4.25s   <- the whole wait is this one
 *   entry done                     5.33s
 *
 * The tool list is the only part the entry point actually needs, and it barely
 * changes between runs. Cached on disk it registers instantly and the client
 * connects in the background, taking the slowest server off the critical path.
 * A tool call that arrives before its bridge is ready simply awaits `ready`.
 */
const TOOL_CACHE_DIR = process.env.TEAMCLU_MCP_TOOL_CACHE_DIR;

/** Stable per-signature filename. FNV-1a: no crypto import, and collisions only
 *  cost a cache miss because the stored signature is compared on read. */
function cacheKey(signature: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function cachePath(label: string, signature: string): string | null {
  if (!TOOL_CACHE_DIR) return null;
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${TOOL_CACHE_DIR}/${safe}.${cacheKey(signature)}.json`;
}

function readToolCache(label: string, signature: string): McpTool[] | null {
  const p = cachePath(label, signature);
  if (!p) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    // The signature is stored as well as hashed: a hash collision, or a stale
    // file from an older spec, must miss rather than register wrong tools.
    if (parsed?.signature !== signature) return null;
    const tools = parsed?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    return tools.filter((t: any) => t && typeof t.name === "string");
  } catch {
    return null;
  }
}

function writeToolCache(label: string, signature: string, tools: McpTool[]): void {
  const p = cachePath(label, signature);
  if (!p || tools.length === 0) return;
  try {
    // Only the fields registration needs; annotations and the rest would bloat
    // the file without changing what gets registered.
    const slim = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    fs.writeFileSync(p, JSON.stringify({ signature, tools: slim }));
  } catch (e) {
    console.error(`[teamclu] MCP tool cache write failed (${label}): ${e}`);
  }
}

/** Connect and list, or throw. */
async function handshake(
  label: string,
  spec: McpServerSpec,
  sdk: Sdk,
): Promise<{ bridge: McpBridge; tools: McpTool[] }> {
  const bridge = await McpBridge.connect(label, spec, sdk);
  try {
    return { bridge, tools: await bridge.listTools() };
  } catch (e) {
    void bridge.close(); // never leak a connection whose listing failed
    throw e;
  }
}

/**
 * Get a bridge entry for `label`, connecting only when there is not already one
 * with the same spec. A changed spec tears the old one down first — that is
 * what makes an MCP config edit take effect without restarting pi.
 *
 * Returns as soon as a tool list is known: from the live registry, from the
 * on-disk cache (connecting in the background), or — only on the very first run
 * for a given spec — from a full handshake.
 */
async function ensureBridge(label: string, spec: McpServerSpec, sdk: Sdk): Promise<BridgeEntry> {
  const signature = bridgeSignature(spec);
  const existing = BRIDGE_REGISTRY.get(label);
  if (existing) {
    if (existing.signature === signature) return existing;
    disposeEntry(existing);
    BRIDGE_REGISTRY.delete(label);
  }

  const watchToolList = (entry: BridgeEntry, bridge: McpBridge) => {
    bridge.onToolListChanged(sdk, () => {
      void bridge
        .listTools()
        .then((tools) => {
          entry.tools = tools;
          entry.provisional = false;
          writeToolCache(label, signature, tools);
          // Newly announced tools have to be registered on the extension
          // instance that is live now; the one this bridge was created from
          // may belong to a session that has since ended.
          const target = WATCH_STATE.target;
          if (target) registerBridgeTools(target.pi, target.ownTools, label, entry);
        })
        .catch((e) => console.error(`[teamclu] MCP ${label}: tools/list_changed refresh failed: ${e}`));
    });
  };

  const cached = readToolCache(label, signature);
  if (cached) {
    const pending = handshake(label, spec, sdk);
    const entry: BridgeEntry = {
      ready: pending.then((r) => r.bridge),
      signature,
      tools: cached,
      provisional: true,
    };
    BRIDGE_REGISTRY.set(label, entry);
    // Derived chain, so `entry.ready` keeps its own rejection for awaiting
    // tool calls instead of being swallowed here.
    void pending.then(
      ({ bridge, tools }) => {
        entry.tools = tools;
        entry.provisional = false;
        writeToolCache(label, signature, tools);
        watchToolList(entry, bridge);
      },
      (e) => {
        // Drop the entry so the next session retries rather than inheriting a
        // bridge that will never answer.
        if (BRIDGE_REGISTRY.get(label) === entry) BRIDGE_REGISTRY.delete(label);
        console.error(`[teamclu] MCP bridge failed after cached start (${label}): ${e}`);
      },
    );
    return entry;
  }

  const { bridge, tools } = await handshake(label, spec, sdk);
  writeToolCache(label, signature, tools);
  const entry: BridgeEntry = {
    ready: Promise.resolve(bridge),
    signature,
    tools,
    provisional: false,
  };
  BRIDGE_REGISTRY.set(label, entry);
  watchToolList(entry, bridge);
  return entry;
}

function disposeEntry(entry: BridgeEntry): void {
  // The connection may still be opening; close it when it lands either way.
  void entry.ready.then(
    (b) => {
      releaseToolNames(b.label);
      void b.close();
    },
    () => {},
  );
}

/** Tear down bridges whose server is no longer configured. */
function disposeRemovedBridges(configured: Set<string>): void {
  for (const [label, entry] of [...BRIDGE_REGISTRY]) {
    if (configured.has(label)) continue;
    disposeEntry(entry);
    BRIDGE_REGISTRY.delete(label);
  }
}

/**
 * Read the workspace MCP config the same way amuxd does when it builds
 * `TEAMCLU_MCP_SERVERS` (`pi_server_spec` in `pi_rpc/mod.rs`): skip the
 * daemon's own remote-tools entry and `enabled: false`; a `type: "remote"`
 * entry needs a URL, anything else needs a non-empty string `command` array.
 *
 * Kept deliberately in sync with the Rust side — the env payload is a snapshot
 * of this file at spawn, so a watcher re-reading it must apply the same rules
 * or a reload would bridge servers the initial pass rejected.
 *
 * Returns `null` when the file cannot be read or parsed, which the caller must
 * treat as "no information" rather than "no servers". Editors save atomically
 * (write temp, rename), so a read can land mid-write; answering `{}` there
 * would tear down every working bridge over a transient half-written file, and
 * nothing would bring them back until the next edit.
 */
function readMcpServers(configPath: string): Record<string, McpServerSpec> | null {
  let root: any;
  try {
    root = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  // Valid JSON with no `mcp` section genuinely means "no servers".
  const mcp = root?.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  const out: Record<string, McpServerSpec> = {};
  for (const [name, raw] of Object.entries(mcp)) {
    if (name === "amuxd-remote-tools") continue;
    const spec = normalizeServerSpec(raw);
    if (spec) out[name] = spec;
  }
  return out;
}

/** One config entry (from the env payload or a config reload) → a spec, or
 *  null when it cannot be bridged. */
function normalizeServerSpec(raw: unknown): McpServerSpec | null {
  const spec = raw as any;
  if (!spec || typeof spec !== "object") return null;
  if (spec.enabled === false) return null;
  if (spec.type === "remote") {
    return typeof spec.url === "string" && spec.url.length > 0
      ? { type: "remote", url: spec.url, headers: spec.headers }
      : null;
  }
  const cmd = spec.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c: unknown) => typeof c === "string")) {
    return null;
  }
  return { type: "local", command: cmd as string[], environment: spec.environment };
}

/** Bring the live bridges in line with `servers`: drop what is gone, connect
 *  what is new, leave unchanged ones alone (the registry decides by signature). */
async function reconcileBridges(
  pi: ExtensionAPI,
  ownTools: Set<string>,
  servers: Record<string, McpServerSpec>,
): Promise<void> {
  const names = Object.keys(servers);
  // "remote-tools" is bridged from its own env contract, not from this file.
  disposeRemovedBridges(new Set([...names, "remote-tools"]));
  await Promise.all(names.map((name) => bridgeMcpServer(pi, ownTools, name, servers[name])));
}

/**
 * The extension instance a config reload should register new tools on.
 *
 * `pi.registerTool` binds to the instance that is passed to the entry point,
 * and the entry point runs again per session — so the watcher, which outlives
 * any one session, cannot capture a `pi` and keep it. It reads the newest one
 * from here instead, which the entry point refreshes on every run.
 */
const WATCH_STATE: { target: { pi: ExtensionAPI; ownTools: Set<string> } | null; started: boolean } =
  ((globalThis as any).__teamcluMcpWatchState ??= { target: null, started: false });

/**
 * Watch the workspace MCP config and re-bridge on edit.
 *
 * Without this an MCP config change only lands when the pi process itself is
 * replaced, because `TEAMCLU_MCP_SERVERS` is read once at spawn. Watching the
 * *directory* rather than the file is deliberate: editors write config atomically
 * (write temp + rename), which detaches an `fs.watch` bound to the old inode and
 * silently stops delivering events.
 *
 * Idempotent and process-wide: the entry point calls it every session, and only
 * the first call installs anything.
 */
function ensureMcpConfigWatcher(): void {
  if (WATCH_STATE.started) return;
  const configPath = process.env.TEAMCLU_MCP_CONFIG_PATH;
  if (!configPath) return;
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(dir, (_event, filename) => {
      // A rename fires for the temp file too; only the real name matters.
      if (filename && filename !== base) return;
      if (timer) clearTimeout(timer);
      // One save can fire several events (truncate, write, rename).
      timer = setTimeout(() => {
        timer = null;
        const target = WATCH_STATE.target;
        if (!target) return;
        const servers = readMcpServers(configPath);
        if (!servers) {
          console.error(`[teamclu] MCP config unreadable; keeping current bridges: ${configPath}`);
          return;
        }
        void reconcileBridges(target.pi, target.ownTools, servers).catch((e) =>
          console.error(`[teamclu] MCP config reload failed: ${e}`),
        );
      }, 250);
    });
    WATCH_STATE.started = true;
  } catch (e) {
    // No watch ⇒ config changes need a pi restart, as before. Not fatal.
    console.error(`[teamclu] MCP config watch unavailable (${configPath}): ${e}`);
  }
}

/** Register (or re-register) every tool a bridge currently exposes. Safe to
 *  call repeatedly: the name a tool gets is stable for its server. */
function registerBridgeTools(
  pi: ExtensionAPI,
  ownTools: Set<string>,
  label: string,
  entry: BridgeEntry,
): void {
  for (const tool of entry.tools) {
    const name = registeredName(label, tool.name);
    ownTools.add(name);
    pi.registerTool({
      name,
      label: name,
      description: tool.description ?? `TeamClu MCP tool ${tool.name} (${label})`,
      // MCP inputSchema is plain JSON Schema; pi's TypeBox parameters are
      // JSON Schema objects at runtime, so pass it through directly.
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_toolCallId, params, signal) {
        // A server can drop a tool at runtime (`tools/list_changed`). pi has no
        // unregister, so the registration outlives the tool: answer honestly
        // instead of calling a name the server no longer knows.
        if (!entry.tools.some((t) => t.name === tool.name)) {
          return {
            content: [{ type: "text" as const, text: `MCP tool ${tool.name} is no longer offered by ${label}.` }],
            isError: true,
          };
        }
        // On a cached start the connection may still be opening; this is the
        // only place that waits for it, and only when a tool is actually used.
        const bridge = await entry.ready;
        const result = await bridge.callTool(tool.name, params ?? {}, signal);
        return { content: toPiContent(result), isError: result?.isError === true };
      },
    });
  }
}

/** Reuse (or open) one MCP server and register its tools on `pi`.
 *  Best-effort: a failed server never breaks the others. */
async function bridgeMcpServer(
  pi: ExtensionAPI,
  ownTools: Set<string>,
  label: string,
  spec: McpServerSpec,
): Promise<void> {
  const sdk = await loadSdk();
  if (!sdk) return; // already reported once by loadSdk
  try {
    registerBridgeTools(pi, ownTools, label, await ensureBridge(label, spec, sdk));
  } catch (e) {
    // Bridge is best-effort: pi still works without this server's tools.
    console.error(`[teamclu] MCP bridge unavailable (${label}): ${e}`);
  }
}

// ---------------------------------------------------------------------------
// question tool
// ---------------------------------------------------------------------------

/** Marker prefix on a select dialog title that carries a question payload.
 *  Must match `QUESTION_MARKER` in `pi_rpc/translate.rs`. */
const QUESTION_MARKER = "teamclu.question=";

type QuestionSpec = {
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string } | string>;
  multiple?: boolean;
};

function questionOptionLabels(q: QuestionSpec): string[] {
  return (q.options ?? [])
    .map((o) => (typeof o === "string" ? o : (o?.label ?? "")))
    .filter((label) => label.length > 0);
}

function registerQuestionTool(pi: ExtensionAPI, ownTools: Set<string>): void {
  ownTools.add("question");
  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user one or more questions and wait for their answers. Use this when you " +
      "need a decision, a preference, or a piece of information only the user has. Each " +
      "question offers a fixed set of options; the user may also type a custom answer.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user.",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The complete question to ask." },
              header: {
                type: "string",
                description: "Very short label for the question (a few words).",
              },
              options: {
                type: "array",
                description: "The choices offered to the user.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text of this choice." },
                    description: {
                      type: "string",
                      description: "What choosing this option means.",
                    },
                  },
                  required: ["label"],
                },
              },
              multiple: {
                type: "boolean",
                description: "Allow selecting more than one option.",
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const questions = Array.isArray(params?.questions)
        ? (params.questions as QuestionSpec[])
        : [];
      if (questions.length === 0) {
        return { content: [{ type: "text", text: "No questions provided." }], isError: true };
      }
      if (!ctx) {
        return {
          content: [{ type: "text", text: "Question UI unavailable in this run mode." }],
          isError: true,
        };
      }
      const payload = JSON.stringify({ toolCallId, questions });
      // Flattened labels keep the dialog renderable by a plain select UI; the
      // TeamClu host reads the marker payload instead.
      const flatLabels = questionOptionLabels(questions[0] ?? {});
      const value = await ctx.ui.select(`${QUESTION_MARKER}${payload}`, flatLabels, { signal });
      if (value === undefined) {
        return {
          content: [{ type: "text", text: "The user dismissed the question without answering." }],
          isError: true,
        };
      }
      // amuxd answers with `[["label", …], …]` (one array per question, in
      // order); a bare string is a plain select's answer to question 1.
      let answers: string[][];
      try {
        const parsed = JSON.parse(value);
        answers = Array.isArray(parsed)
          ? parsed.map((a: unknown) =>
              Array.isArray(a) ? a.map(String) : a === undefined || a === null ? [] : [String(a)],
            )
          : [[String(parsed)]];
      } catch {
        answers = [[value]];
      }
      const lines = questions.map((q, i) => {
        const answer = answers[i] ?? [];
        const label = q.header || q.question || `Question ${i + 1}`;
        return `${label}: ${answer.length > 0 ? answer.join(", ") : "(no answer)"}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // Team shared LLM — register before startup finishes so its models appear.
  registerTeamProvider(pi);

  // Tools this extension registered itself (remote-tools proxies). They are
  // daemon-provided, already trusted — skip the permission gate for them.
  const ownTools = new Set<string>();

  // -- `question` tool ---------------------------------------------------------
  // Parity with opencode's built-in question tool: the agent asks the user one
  // or more multiple-choice questions and blocks on the answer. pi has no such
  // tool, but its extension UI channel has `select` — so the whole question
  // payload rides a select dialog's title behind a machine-readable marker.
  // amuxd (`pi_rpc/events.rs`) recognizes the marker, renders the interactive
  // card, and replies with the answers JSON as the select's `value`. A plain
  // select response (no JSON) still works: it is treated as the answer to the
  // first question, which is what a TUI select would produce.
  registerQuestionTool(pi, ownTools);

  // -- Permission gate -------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    if (ownTools.has(event.toolName)) return undefined;

    const rules = loadRules(); // re-read per call: daemon appends "always" grants
    if (rules.defaultAction === "allow") return undefined;

    const key = matchKey(event.toolName, event.input ?? {});
    if (rules.alwaysAllowed.some((p) => patternMatches(p, key))) return undefined;

    const pattern = alwaysPattern(event.toolName, event.input ?? {});
    const title = `${event.toolName}: ${summarize(event.toolName, event.input ?? {})}`;
    // Trailer line is machine-read by amuxd (and its "always" substring makes
    // the host offer an "Always allow" option).
    const argsJson = (JSON.stringify(event.input ?? {}, null, 2) ?? "{}").slice(0, 2000);
    const message = `${argsJson}\n\nteamclu.always-pattern=${pattern}`;

    const confirmed = await ctx.ui.confirm(title, message);
    if (!confirmed) {
      return { block: true, reason: "Denied by TeamClu permission gate" };
    }
    return undefined;
  });

  // -- MCP bridges (pi has no native MCP) -----------------------------------
  // 1) amuxd remote-tools (single stdio command, its own env contract).
  const cmdRaw = process.env.TEAMCLU_REMOTE_TOOLS_CMD;
  if (cmdRaw) {
    try {
      const cmd = JSON.parse(cmdRaw);
      if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === "string")) {
        await bridgeMcpServer(pi, ownTools, "remote-tools", { type: "local", command: cmd });
      }
    } catch (e) {
      console.error(`[teamclu] invalid TEAMCLU_REMOTE_TOOLS_CMD: ${e}`);
    }
  }

  // 2) The workspace's other MCP servers (from opencode.json `mcp`), bridged so
  //    pi gets the same tools opencode loads natively — local and remote alike,
  //    normalized by amuxd into:
  //    { "<name>": { "type": "local",  "command": [...], "environment": {…} } }
  //    { "<name>": { "type": "remote", "url": "…",       "headers": {…} } }
  // Point the config watcher at this session's instance BEFORE bridging, and
  // unconditionally — including when nothing is configured yet. Doing it inside
  // the "has servers" branch below would mean a workspace that starts with no
  // MCP servers never gets a watcher, so adding the first one would still need
  // a pi restart, which is the case this exists to remove.
  WATCH_STATE.target = { pi, ownTools };
  ensureMcpConfigWatcher();

  const serversRaw = process.env.TEAMCLU_MCP_SERVERS;
  if (serversRaw) {
    let servers: Record<string, unknown>;
    try {
      servers = JSON.parse(serversRaw);
    } catch (e) {
      console.error(`[teamclu] invalid TEAMCLU_MCP_SERVERS: ${e}`);
      servers = {};
    }
    const valid: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries(servers)) {
      // Same normalizer the config watcher uses, so a server accepted at spawn
      // and a server accepted on reload can never disagree.
      const normalized = normalizeServerSpec(spec);
      if (normalized) valid[name] = normalized;
    }
    // Drops servers that are no longer configured before adding the rest (so an
    // edit that replaces one server with another does not leave both running),
    // then connects in parallel. Only the FIRST session in this process pays a
    // connection at all — later ones reuse the registry — but that first one
    // used to pay for every server end to end, ~4s each for the npx-based ones.
    await reconcileBridges(pi, ownTools, valid);
  }
}
