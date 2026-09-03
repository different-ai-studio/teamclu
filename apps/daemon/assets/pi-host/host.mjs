/**
 * TeamClu pi multi-session host.
 *
 * Shipped inside amuxd (`include_str!`), materialized to
 * `<cache>/pi/host/host.mjs` at spawn and run as `node host.mjs …`.
 *
 * ## Why this exists
 *
 * `pi --mode rpc` is a *single-session* protocol: none of its 35 commands carry
 * a session id, its events carry none either, and `switch_session` tears the
 * outgoing session down (`session.abort()` + `dispose()`), destroying a running
 * turn and its `agent_end`. One worktree could therefore hold exactly one live
 * TeamClu session, and a second one prompting got
 * "pi is mid-turn on another session".
 *
 * pi's own docs point at the way out: "If you're building a Node.js
 * application, consider using `AgentSession` directly". A single Node process
 * can hold N independent `AgentSession`s, each with its own `subscribe`, its own
 * `ExtensionRunner` (hence its own UI/permission context), and its own abort.
 *
 * So this host keeps the amuxd-facing shape of `--mode rpc` — JSONL over
 * stdio, `{type:"response",id,…}` correlation, pi's own event objects — and
 * adds exactly one field: `sessionId`, on every command and every event.
 * `pi_rpc/translate.rs` therefore needs no changes.
 *
 * ## What is shared, and why the process is still per-worktree
 *
 * `AgentSessionServices` is cwd-bound (model runtime + settings + resource
 * loader) and every session in this host shares one worktree, so all sessions
 * share one services object. That is the whole memory story: extensions — and
 * with them the TeamClu extension's MCP bridges — load ONCE per process, not
 * once per session. Three sessions cost roughly one session's resident set plus
 * their conversations, instead of 3 × 145MB plus 3 × every npx MCP server.
 *
 * Each session still gets its own `ExtensionRunner` (pi builds one per
 * `AgentSession`), and `ctx.ui` resolves through that runner — which is why a
 * permission dialog raised by session B is asked of session B and cannot be
 * mis-attributed to whichever session happens to be "active". Note the one
 * shared piece: `ExtensionRuntime`-level action closures (`pi.sendMessage`,
 * `pi.setModel`, …) are overwritten by whichever session was created last. No
 * TeamClu extension uses them, and stock `pi --mode rpc` has the same
 * last-bind-wins behaviour across `switch_session`, so this is not a regression.
 *
 * ## Protocol
 *
 * Commands (stdin, one JSON object per line):
 *
 *   {id, type:"ping"}
 *   {id, type:"open_session", sessionPath}     -> {sessionId, sessionFile, piSessionId}
 *   {id, type:"new_session"}                   -> {sessionId, sessionFile, piSessionId}
 *   {id, type:"close_session", sessionId}      -> {}
 *   {id, type:"prompt", sessionId, message, streamingBehavior?}
 *   {id, type:"abort", sessionId}
 *   {id, type:"set_model", sessionId, provider, modelId}
 *   {id, type:"get_available_models"}          -> {models}
 *   {id, type:"get_state", sessionId}          -> RpcSessionState
 *   {id, type:"get_entries", sessionId, since?} -> {entries, leafId}
 *   {id, type:"get_commands", sessionId}       -> {commands}
 *   {type:"extension_ui_response", id, value|confirmed|cancelled}
 *
 * Provider auth — pi's `/login`, driven from the TeamClu settings pane. These
 * are host-level (no `sessionId`): credentials live in one device-wide
 * `auth.json` and custom providers in one device-wide `models.json`, so they
 * are a property of the host, not of any session. See the "provider auth"
 * section below for why login is ack-then-event rather than one long response.
 *
 *   {id, type:"auth_list"}                     -> {agentDir, authPath, modelsPath, providers}
 *   {id, type:"auth_login_start", loginId, providerId, authType}  -> {} (ack)
 *   {id, type:"auth_login_cancel", loginId}    -> {}
 *   {id, type:"auth_logout", providerId}       -> {}
 *   {id, type:"auth_refresh", providerId?}     -> {aborted, errors}
 *   {id, type:"auth_models_get"}               -> {path, providers}
 *   {id, type:"auth_models_put", providerId, provider} -> {}
 *   {id, type:"auth_models_delete", providerId}        -> {}
 *   {type:"auth_prompt_response", loginId, promptId, value|cancelled}
 *
 * Output (stdout, one JSON object per line):
 *
 *   {type:"host_ready", protocol, piVersion}
 *   {type:"response", id, command, success, data?|error?}
 *   {type:"<pi event>", sessionId, …}
 *   {type:"extension_ui_request", id, sessionId, method, …}
 *   {type:"extension_error", sessionId, …}
 *   {type:"auth_event", loginId, event}            (pi's AuthEvent, verbatim)
 *   {type:"auth_prompt", loginId, promptId, prompt}
 *   {type:"auth_prompt_cancel", loginId, promptId}
 *   {type:"auth_login_end", loginId, providerId, success, error?, refreshError?}
 *
 * `sessionId` is `pi:<absolute session file path>` — the same acp session id
 * amuxd already uses, so it stays self-contained across daemon restarts. The
 * host is authoritative for it: `open_session` / `new_session` return the id,
 * callers never invent one.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// stdout guard
// ---------------------------------------------------------------------------

// Captured before anything else can write: stdout is the protocol channel, and
// one stray `console.log` from an extension would corrupt a JSONL record. Same
// job as pi's own `output-guard.takeOverStdout()`, reimplemented here so the
// host depends only on the package's public entry point.
const rawWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) =>
  process.stderr.write(chunk, encoding, callback);

function out(obj) {
  try {
    rawWrite(`${JSON.stringify(obj)}\n`);
  } catch (e) {
    process.stderr.write(`[pi-host] write failed: ${e}\n`);
  }
}

function log(message) {
  process.stderr.write(`[pi-host] ${message}\n`);
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { extensions: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--pi-package":
        args.piPackage = value;
        i++;
        break;
      case "--cwd":
        args.cwd = value;
        i++;
        break;
      case "--session-dir":
        args.sessionDir = value;
        i++;
        break;
      case "--extension":
        if (value) args.extensions.push(value);
        i++;
        break;
      default:
        log(`ignoring unknown argument: ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/** Import a module from inside the pi package by absolute path.
 *
 * The package's `exports` map only publishes `.`, `./rpc-entry` and `./client`,
 * so a deep specifier import is blocked — an absolute file URL is not. Used
 * only for optional extras (theme, http dispatcher); a miss is not fatal. */
async function optionalImport(relative) {
  try {
    return await import(pathToFileURL(path.join(args.piPackage, relative)).href);
  } catch (e) {
    log(`optional module ${relative} unavailable: ${e}`);
    return undefined;
  }
}

let pi;
try {
  if (!args.piPackage) throw new Error("--pi-package is required");
  if (!args.cwd) throw new Error("--cwd is required");
  pi = await import(pathToFileURL(path.join(args.piPackage, "dist", "index.js")).href);
} catch (e) {
  out({ type: "host_error", error: `pi package import failed: ${e}` });
  process.exit(1);
}

// Matches `dist/rpc-entry.js`: extensions and providers key off these.
process.title = "pi-teamclu-host";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

// `pi --mode rpc` installs an undici dispatcher (proxy + idle timeout from
// settings). Skipping it would silently drop a configured `httpProxy`, which on
// a network that needs one means every provider call fails.
const httpDispatcher = await optionalImport("dist/core/http-dispatcher.js");
const themeModule = await optionalImport("dist/modes/interactive/theme/theme.js");
const noopTheme = new Proxy(
  {},
  { get: () => (text) => String(text ?? "") },
);

/** `toJsonEvent` from pi's `dist/modes/json-event.js`, inlined.
 *
 * Not re-exported from the package entry point (only its type is), and it is
 * ten lines: strips the cumulative assistant snapshot from streaming deltas so
 * the wire carries deltas, not a growing copy of the whole message. */
function toJsonEvent(event) {
  if (event.type !== "message_update") return event;
  const assistantMessageEvent = event.assistantMessageEvent;
  if (!("partial" in assistantMessageEvent)) {
    return { type: "message_update", usage: event.message?.usage, assistantMessageEvent };
  }
  const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: deltaEvent };
}

let services;
try {
  services = await pi.createAgentSessionServices({
    cwd: args.cwd,
    modelRuntimeSignal: AbortSignal.timeout(15_000),
    resourceLoaderOptions: {
      // Equivalent of `pi -e <path>`: the TeamClu extension (permission gate,
      // team provider, MCP bridges). Loaded once for the whole host.
      additionalExtensionPaths: args.extensions,
    },
  });
} catch (e) {
  out({ type: "host_error", error: `pi services init failed: ${e}` });
  process.exit(1);
}

for (const diagnostic of services.diagnostics ?? []) {
  log(`${diagnostic.type}: ${diagnostic.message}`);
}

try {
  httpDispatcher?.applyHttpProxySettings?.(
    services.settingsManager.getGlobalSettings().httpProxy,
  );
  httpDispatcher?.configureHttpDispatcher?.(services.settingsManager.getHttpIdleTimeoutMs());
} catch (e) {
  log(`http dispatcher setup skipped: ${e}`);
}

const sessionDir = args.sessionDir;

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/** sessionId (`pi:<file>`) -> { session, unsubscribe } */
const sessions = new Map();
/** extension_ui_request id -> { sessionId, resolve } */
const pendingUi = new Map();

function sessionIdFor(session) {
  return `pi:${session.sessionFile ?? ""}`;
}

/** Per-session extension UI context.
 *
 * Every dialog request carries this session's id, so amuxd routes the
 * permission prompt to the chat that triggered it. Under `--mode rpc` there was
 * a single process-wide context and the id had to be guessed from "whichever
 * session is active", which cross-wired approvals as soon as two sessions ran.
 */
function makeUiContext(sessionId) {
  const dialog = (request, defaultValue, parse, opts) => {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        pendingUi.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timer = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      pendingUi.set(id, {
        sessionId,
        resolve: (response) => {
          cleanup();
          resolve(parse(response));
        },
      });
      out({ type: "extension_ui_request", id, sessionId, ...request });
    });
  };
  const fireAndForget = (request) =>
    out({ type: "extension_ui_request", id: crypto.randomUUID(), sessionId, ...request });

  return {
    sessionId,
    select: (title, options, opts) =>
      dialog(
        { method: "select", title, options, timeout: opts?.timeout },
        undefined,
        (r) => (r.cancelled ? undefined : r.value),
        opts,
      ),
    confirm: (title, message, opts) =>
      dialog(
        { method: "confirm", title, message, timeout: opts?.timeout },
        false,
        (r) => (r.cancelled ? false : r.confirmed === true),
        opts,
      ),
    input: (title, placeholder, opts) =>
      dialog(
        { method: "input", title, placeholder, timeout: opts?.timeout },
        undefined,
        (r) => (r.cancelled ? undefined : r.value),
        opts,
      ),
    editor: (title, prefill) =>
      dialog({ method: "editor", title, prefill }, undefined, (r) =>
        r.cancelled ? undefined : r.value,
      ),
    notify: (message, type) =>
      fireAndForget({ method: "notify", message, notifyType: type }),
    setStatus: (key, text) =>
      fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
    setWidget: (key, content, options) => {
      // Component factories need a TUI; only line arrays cross the wire.
      if (content === undefined || Array.isArray(content)) {
        fireAndForget({
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
    },
    setTitle: (title) => fireAndForget({ method: "setTitle", title }),
    setEditorText: (text) => fireAndForget({ method: "set_editor_text", text }),
    pasteToEditor(text) {
      this.setEditorText(text);
    },
    getEditorText: () => "",
    onTerminalInput: () => () => {},
    // Everything below needs a terminal; same no-ops `pi --mode rpc` uses.
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setFooter() {},
    setHeader() {},
    async custom() {
      return undefined;
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent: () => undefined,
    get theme() {
      return themeModule?.theme ?? noopTheme;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching not supported in host mode" }),
    getToolsExpanded: () => false,
    setToolsExpanded() {},
  };
}

async function adoptSession(sessionManager) {
  const { session } = await pi.createAgentSessionFromServices({ services, sessionManager });
  const sessionId = sessionIdFor(session);

  await session.bindExtensions({
    uiContext: makeUiContext(sessionId),
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      reload: async () => {
        // A reload rebuilds this session's extension runner from the SHARED
        // resource loader; it would restart every other session's extensions
        // out from under them. Sessions are cheap to replace instead.
        throw new Error("ctx.reload() is not supported in the TeamClu pi host");
      },
      // Session replacement is amuxd's job (it owns the session lifecycle and
      // the routing table), so the in-band variants report "cancelled" rather
      // than silently swapping a session the daemon still has routes for.
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
    },
    shutdownHandler: () => {
      // An extension asking pi to quit must not take the other sessions with
      // it; drop just this one.
      void closeSession(sessionId);
    },
    onError: (err) =>
      out({
        type: "extension_error",
        sessionId,
        extensionPath: err.extensionPath,
        event: err.event,
        error: String(err.error),
      }),
  });

  const unsubscribe = session.subscribe((event) => {
    try {
      if (event.type === "agent_end") {
        // The session's leaf entry id at turn end: amuxd remembers it as the
        // `get_entries since` cursor for crash backfill.
        out({
          sessionId,
          leafId: session.sessionManager.getLeafId() ?? undefined,
          ...toJsonEvent(event),
        });
      } else {
        out({ sessionId, ...toJsonEvent(event) });
      }
    } catch (e) {
      log(`event serialize failed (${sessionId}): ${e}`);
    }
  });

  sessions.set(sessionId, { session, unsubscribe });
  return { sessionId, session };
}

async function closeSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  sessions.delete(sessionId);
  // Drop any dialog this session was blocked on, otherwise its extension awaits
  // a reply that can no longer be routed.
  for (const [id, pending] of [...pendingUi]) {
    if (pending.sessionId === sessionId) {
      pendingUi.delete(id);
      pending.resolve({ cancelled: true });
    }
  }
  try {
    entry.unsubscribe();
  } catch (e) {
    log(`unsubscribe failed (${sessionId}): ${e}`);
  }
  try {
    // Settle in-flight work before teardown so the aborted turn is persisted.
    await entry.session.abort();
  } catch (e) {
    log(`abort during close failed (${sessionId}): ${e}`);
  }
  try {
    entry.session.dispose();
  } catch (e) {
    log(`dispose failed (${sessionId}): ${e}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// provider auth (pi's `/login`)
// ---------------------------------------------------------------------------

/**
 * pi's `/login` is `ModelRuntime.login(providerId, authType, interaction)`, and
 * `AuthInteraction` is deliberately UI-neutral: `prompt(AuthPrompt)` returns a
 * string, `notify(AuthEvent)` reports a URL / device code / progress line. pi's
 * own TUI is one implementation of that interface; this is another, with the
 * two calls projected onto the JSONL wire so the real UI can live in the
 * desktop app.
 *
 * Everything provider-specific therefore stays inside pi: PKCE and the loopback
 * callback for OpenRouter, the ChatGPT/Claude/Copilot subscription exchanges,
 * device-code polling, the per-provider api-key prompts that also collect
 * provider env (Cloudflare account id, Azure deployment map). We add no OAuth
 * of our own — reimplementing those flows is exactly how they drift out of date.
 *
 * Login is **ack-then-event**, not a single long response: a browser round trip
 * routinely outlives `PiClient`'s 30s request timeout, and a timed-out request
 * would abandon a flow pi is still running. So `auth_login_start` acks
 * immediately and the flow reports through `auth_event` / `auth_prompt` /
 * `auth_login_end`, correlated by a caller-supplied `loginId`.
 */

/** loginId -> {controller, providerId, prompts: Map<promptId, {resolve, reject}>} */
const logins = new Map();

/** `~/.pi/agent` and friends — resolved by pi, never rebuilt from `homedir()`.
 *
 * `getAgentDir()` honours `PI_CODING_AGENT_DIR`, and the `.pi` segment itself
 * comes from the package's `piConfig.configDir`, so a rebranded pi build puts
 * these somewhere else entirely. Asking pi is the only way to stay right. */
function authPaths() {
  const agentDir = pi.getAgentDir();
  return {
    agentDir,
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  };
}

/** Read `models.json`, or `null` when it does not exist.
 *
 * A malformed file throws rather than reading as "empty": treating a parse
 * error as no-config would let the next write silently replace a hand-edited
 * file with whatever the UI happened to be showing. */
async function readModelsJson() {
  const { modelsPath } = authPaths();
  let raw;
  try {
    raw = await fs.readFile(modelsPath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`${modelsPath}: ${e?.message ?? e}`);
  }
  try {
    // Strip a BOM: pi's own loader does, and an editor-written file can carry one.
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`${modelsPath} is not valid JSON: ${e?.message ?? e}`);
  }
}

/** Write `models.json` atomically, preserving every key we do not model.
 *
 * `mutate` receives the parsed document (a fresh `{}` when absent) and edits it
 * in place. Read-modify-write of the whole document is what keeps a hand-written
 * `modelOverrides`, `oauth` or top-level key alive across an edit to one
 * provider. 0600 because `apiKey` values live here. */
async function writeModelsJson(mutate) {
  const { agentDir, modelsPath } = authPaths();
  const doc = (await readModelsJson()) ?? {};
  if (!doc.providers || typeof doc.providers !== "object") doc.providers = {};
  mutate(doc);
  await fs.mkdir(agentDir, { recursive: true });
  // tmp + rename: a crash mid-write must not leave pi with a truncated config
  // it then refuses to load, taking every custom provider down with it.
  const tmp = `${modelsPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, modelsPath);
  return doc;
}

/** Reload `models.json` and recompose providers in this live host.
 *
 * `ModelRuntime.refresh()` re-reads the file (`ModelConfig.load(modelsPath)`)
 * before rebuilding, so an edited custom provider takes effect without
 * respawning — and without disturbing the sessions this host is running. */
async function refreshModelRuntime(providerId, timeoutMs = 20_000) {
  const result = await services.modelRuntime.refresh({
    ...(providerId ? { providers: [providerId] } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    aborted: result?.aborted === true,
    errors: [...(result?.errors ?? new Map())].map(([provider, error]) => ({
      provider,
      error: error?.message ?? String(error),
    })),
  };
}

/** The provider list behind the settings pane.
 *
 * Mirrors `getLoginProviderOptions` in pi's interactive mode: one entry per
 * provider, carrying every auth method it actually offers. `canLogin` is false
 * for ambient-only api-key providers (Vertex ADC, an AWS profile) — those have
 * no `login` on their `ApiKeyAuth`, and pi shows guidance instead of a key
 * field. Rendering a key box for them would collect a credential pi will not
 * read. */
async function listAuthProviders() {
  const runtime = services.modelRuntime;
  const available = new Set(runtime.getAvailableSnapshot().map((m) => m.provider));
  let customIds = new Set();
  try {
    customIds = new Set(Object.keys((await readModelsJson())?.providers ?? {}));
  } catch (e) {
    // A broken models.json must not blank the whole provider list; the custom
    // section reports the parse error separately.
    log(`models.json unreadable while listing providers: ${e?.message ?? e}`);
  }

  const providers = [];
  for (const provider of runtime.getProviders()) {
    const status = runtime.getProviderAuthStatus(provider.id);
    const methods = [];
    if (provider.auth?.oauth) {
      methods.push({
        authType: "oauth",
        name: provider.auth.oauth.name,
        loginLabel: provider.auth.oauth.loginLabel,
        isSubscription: provider.auth.oauth.isSubscription === true,
        canLogin: true,
      });
    }
    if (provider.auth?.apiKey) {
      methods.push({
        authType: "api_key",
        name: provider.auth.apiKey.name,
        canLogin: typeof provider.auth.apiKey.login === "function",
      });
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      configured: status.configured === true,
      // "stored" | "runtime" | "environment" | "fallback" | "models_json_key" |
      // "models_json_command" — the UI needs this to say *why* a provider is
      // configured, and in particular that logging out will not undo an
      // environment variable or a models.json key.
      source: status.source,
      label: status.label,
      credentialType: status.configured
        ? runtime.isUsingOAuth(provider.id)
          ? "oauth"
          : "api_key"
        : undefined,
      isSubscription: runtime.isUsingSubscription(provider.id),
      custom: customIds.has(provider.id),
      modelCount: runtime.getModels(provider.id).length,
      availableModelCount: available.has(provider.id)
        ? runtime.getAvailableSnapshot().filter((m) => m.provider === provider.id).length
        : 0,
      methods,
    });
  }
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return providers;
}

/** Reject and forget every prompt still outstanding on a login. */
function settlePrompts(entry, message) {
  for (const pending of [...entry.prompts.values()]) pending.reject(new Error(message));
  entry.prompts.clear();
}

function startLogin(loginId, providerId, authType) {
  const controller = new AbortController();
  const entry = { controller, providerId, prompts: new Map() };
  logins.set(loginId, entry);

  const interaction = {
    signal: controller.signal,
    notify: (event) => out({ type: "auth_event", loginId, event }),
    prompt: (prompt) =>
      new Promise((resolve, reject) => {
        const promptId = crypto.randomUUID();
        // `AuthPrompt.signal` is an AbortSignal — not serializable, and not
        // ours to forward. It is stripped here and honoured below.
        const { signal, ...wire } = prompt;
        let onAbort;
        const cleanup = () => {
          entry.prompts.delete(promptId);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted) {
          reject(new Error("Login cancelled"));
          return;
        }
        if (signal) {
          // Per-prompt cancellation, distinct from cancelling the login: pi
          // races a `manual_code` prompt against its loopback callback server
          // and aborts the prompt when the callback wins. Without this the UI
          // would sit on a paste-your-code box that pi has already moved past.
          onAbort = () => {
            cleanup();
            out({ type: "auth_prompt_cancel", loginId, promptId });
            reject(new Error("Login cancelled"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
        entry.prompts.set(promptId, {
          resolve: (value) => {
            cleanup();
            resolve(value);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        });
        out({ type: "auth_prompt", loginId, promptId, prompt: wire });
      }),
  };

  void services.modelRuntime
    .login(providerId, authType, interaction)
    .then(async () => {
      // Same follow-up as interactive mode: reload this provider's catalog so
      // the models it just unlocked appear without a respawn. A refresh failure
      // is reported but does not demote the login — the credential is stored,
      // and pi falls back to the cached catalog.
      let refreshError;
      try {
        const result = await refreshModelRuntime(providerId, 15_000);
        if (result.aborted) refreshError = "model catalog refresh timed out";
        else if (result.errors.length > 0) refreshError = result.errors[0].error;
      } catch (e) {
        refreshError = e?.message ?? String(e);
      }
      out({ type: "auth_login_end", loginId, providerId, success: true, refreshError });
    })
    .catch((e) => {
      out({
        type: "auth_login_end",
        loginId,
        providerId,
        success: false,
        error: e?.message ?? String(e),
      });
    })
    .finally(() => {
      settlePrompts(entry, "Login finished");
      logins.delete(loginId);
    });
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const ok = (id, command, data) =>
  data === undefined
    ? { id, type: "response", command, success: true }
    : { id, type: "response", command, success: true, data };
const fail = (id, command, error) => ({ id, type: "response", command, success: false, error });

function requireSession(command) {
  const entry = sessions.get(command.sessionId);
  if (!entry) throw new Error(`Unknown sessionId: ${command.sessionId}`);
  return entry.session;
}

async function handleCommand(command) {
  const id = command.id;
  switch (command.type) {
    case "ping":
      return ok(id, "ping", {
        protocol: PROTOCOL_VERSION,
        piVersion: pi.VERSION ?? "",
        sessions: sessions.size,
      });

    case "open_session": {
      if (!command.sessionPath) return fail(id, "open_session", "sessionPath is required");
      const sessionManager = pi.SessionManager.open(command.sessionPath, sessionDir);
      const existing = `pi:${sessionManager.getSessionFile() ?? ""}`;
      // Idempotent: a re-attach of a session this host already holds must reuse
      // it, not build a second AgentSession over the same jsonl (two writers on
      // one file interleave entries and corrupt the branch).
      if (sessions.has(existing)) {
        const session = sessions.get(existing).session;
        return ok(id, "open_session", {
          sessionId: existing,
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
          leafId: session.sessionManager.getLeafId() ?? undefined,
          reused: true,
        });
      }
      const { sessionId, session } = await adoptSession(sessionManager);
      return ok(id, "open_session", {
        sessionId,
        sessionFile: session.sessionFile,
        piSessionId: session.sessionId,
        leafId: session.sessionManager.getLeafId() ?? undefined,
        reused: false,
      });
    }

    case "new_session": {
      const sessionManager = pi.SessionManager.create(args.cwd, sessionDir);
      const { sessionId, session } = await adoptSession(sessionManager);
      return ok(id, "new_session", {
        sessionId,
        sessionFile: session.sessionFile,
        piSessionId: session.sessionId,
        leafId: session.sessionManager.getLeafId() ?? undefined,
      });
    }

    case "fork_session": {
      if (!command.parentSessionPath) {
        return fail(id, "fork_session", "parentSessionPath is required");
      }
      if (!command.forkLeafId) {
        return fail(id, "fork_session", "forkLeafId is required");
      }
      const parentManager = pi.SessionManager.open(command.parentSessionPath, sessionDir);
      const branchedManager = parentManager.createBranchedSession(command.forkLeafId);
      const newPath = branchedManager.getSessionFile();
      if (!newPath) {
        return fail(id, "fork_session", "createBranchedSession returned no session file");
      }
      const sessionId = `pi:${newPath}`;
      return ok(id, "fork_session", {
        sessionId,
        sessionFile: newPath,
        leafId: branchedManager.getLeafId() ?? undefined,
      });
    }

    case "close_session":
      return ok(id, "close_session", { closed: await closeSession(command.sessionId) });

    case "prompt": {
      const session = requireSession(command);
      // Same shape as `pi --mode rpc`: the response is the preflight verdict,
      // not the turn's completion. Emitting it early is what lets amuxd close
      // the turn on `agent_end` rather than on the command ack.
      let preflightSucceeded = false;
      void session
        .prompt(command.message, {
          images: command.images,
          streamingBehavior: command.streamingBehavior,
          source: "rpc",
          preflightResult: (didSucceed) => {
            if (didSucceed) {
              preflightSucceeded = true;
              out(ok(id, "prompt"));
            }
          },
        })
        .catch((e) => {
          if (!preflightSucceeded) out(fail(id, "prompt", e?.message ?? String(e)));
        });
      return undefined;
    }

    case "abort": {
      // Per session: aborts this session's agent run only. The other sessions
      // in this process keep streaming.
      await requireSession(command).abort();
      return ok(id, "abort");
    }

    case "set_model": {
      const session = requireSession(command);
      const models = session.modelRuntime.getAvailableSnapshot();
      const model = models.find(
        (m) => m.provider === command.provider && m.id === command.modelId,
      );
      if (!model) {
        return fail(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
      }
      await session.setModel(model);
      return ok(id, "set_model", model);
    }

    case "get_available_models":
      // Host-level: the model runtime is shared, so this answers without a
      // session — which is what the cron/catalog path needs on a cold host.
      return ok(id, "get_available_models", {
        models: services.modelRuntime.getAvailableSnapshot(),
      });

    case "get_state": {
      const session = requireSession(command);
      return ok(id, "get_state", {
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        isStreaming: session.isStreaming,
        isCompacting: session.isCompacting,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        autoCompactionEnabled: session.autoCompactionEnabled,
        messageCount: session.messages.length,
        pendingMessageCount: session.pendingMessageCount,
      });
    }

    case "get_entries": {
      const sessionManager = requireSession(command).sessionManager;
      let entries = sessionManager.getEntries();
      if (command.since !== undefined) {
        const sinceIndex = entries.findIndex((e) => e.id === command.since);
        if (sinceIndex === -1) return fail(id, "get_entries", `Entry not found: ${command.since}`);
        entries = entries.slice(sinceIndex + 1);
      }
      return ok(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
    }

    case "get_commands": {
      const session = requireSession(command);
      const commands = [];
      for (const registered of session.extensionRunner.getRegisteredCommands()) {
        commands.push({
          name: registered.invocationName,
          description: registered.description,
          source: "extension",
        });
      }
      for (const template of session.promptTemplates) {
        commands.push({
          name: template.name,
          description: template.description,
          source: "prompt",
        });
      }
      for (const skill of session.resourceLoader.getSkills().skills) {
        commands.push({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
        });
      }
      return ok(id, "get_commands", { commands });
    }

    // ── provider auth ────────────────────────────────────────────────────────

    case "auth_list": {
      const { agentDir, authPath, modelsPath } = authPaths();
      return ok(id, "auth_list", {
        agentDir,
        authPath,
        modelsPath,
        providers: await listAuthProviders(),
      });
    }

    case "auth_login_start": {
      if (!command.loginId) return fail(id, "auth_login_start", "loginId is required");
      if (!command.providerId) return fail(id, "auth_login_start", "providerId is required");
      const authType = command.authType;
      if (authType !== "oauth" && authType !== "api_key") {
        return fail(id, "auth_login_start", `Unsupported authType: ${authType}`);
      }
      if (logins.has(command.loginId)) {
        return fail(id, "auth_login_start", `Login already running: ${command.loginId}`);
      }
      const provider = services.modelRuntime.getProvider(command.providerId);
      if (!provider) {
        return fail(id, "auth_login_start", `Unknown provider: ${command.providerId}`);
      }
      // Refused here rather than left to pi so the caller gets a real error
      // instead of a login that emits nothing and never ends. Ambient api-key
      // providers (AWS profile, Vertex ADC) land here too — they have no
      // interactive setup at all.
      const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
      if (!method || (authType === "api_key" && typeof method.login !== "function")) {
        return fail(
          id,
          "auth_login_start",
          `${provider.name} does not support ${authType} login`,
        );
      }
      startLogin(command.loginId, command.providerId, authType);
      return ok(id, "auth_login_start");
    }

    case "auth_login_cancel": {
      const entry = logins.get(command.loginId);
      if (entry) {
        // Abort first so a provider flow blocked on its own network wait
        // unwinds, then reject the prompt it is parked on: the interaction
        // signal alone does not settle a promise we created.
        entry.controller.abort();
        settlePrompts(entry, "Login cancelled");
      }
      return ok(id, "auth_login_cancel");
    }

    case "auth_logout": {
      if (!command.providerId) return fail(id, "auth_logout", "providerId is required");
      await services.modelRuntime.logout(command.providerId, {
        signal: AbortSignal.timeout(15_000),
      });
      return ok(id, "auth_logout");
    }

    case "auth_refresh":
      return ok(id, "auth_refresh", await refreshModelRuntime(command.providerId));

    case "auth_models_get": {
      const { modelsPath } = authPaths();
      return ok(id, "auth_models_get", {
        path: modelsPath,
        providers: (await readModelsJson())?.providers ?? {},
      });
    }

    case "auth_models_put": {
      if (!command.providerId) return fail(id, "auth_models_put", "providerId is required");
      if (!command.provider || typeof command.provider !== "object") {
        return fail(id, "auth_models_put", "provider must be an object");
      }
      await writeModelsJson((doc) => {
        doc.providers[command.providerId] = command.provider;
      });
      // Full rebuild, not `{providers:[id]}`: a brand-new provider id has
      // nothing to recompose yet, and `recomposeProvider` on an id the runtime
      // has never seen leaves it absent from the snapshot.
      return ok(id, "auth_models_put", await refreshModelRuntime());
    }

    case "auth_models_delete": {
      if (!command.providerId) return fail(id, "auth_models_delete", "providerId is required");
      await writeModelsJson((doc) => {
        delete doc.providers[command.providerId];
      });
      return ok(id, "auth_models_delete", await refreshModelRuntime());
    }

    default:
      return fail(id, command.type ?? "unknown", `Unknown command: ${command.type}`);
  }
}

// ---------------------------------------------------------------------------
// stdin loop
// ---------------------------------------------------------------------------

async function handleLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    out(fail(undefined, "parse", `Failed to parse command: ${e}`));
    return;
  }
  if (parsed?.type === "extension_ui_response") {
    const pending = pendingUi.get(parsed.id);
    if (pending) {
      pendingUi.delete(parsed.id);
      pending.resolve(parsed);
    } else {
      log(`extension_ui_response for unknown request ${parsed.id}`);
    }
    return;
  }
  if (parsed?.type === "auth_prompt_response") {
    const pending = logins.get(parsed.loginId)?.prompts.get(parsed.promptId);
    if (!pending) {
      // Normal on a race: pi aborted this prompt (its callback server won) at
      // the same moment the user answered it. The flow is already past it.
      log(`auth_prompt_response for unknown prompt ${parsed.loginId}/${parsed.promptId}`);
      return;
    }
    if (parsed.cancelled) pending.reject(new Error("Login cancelled"));
    else pending.resolve(String(parsed.value ?? ""));
    return;
  }
  try {
    const response = await handleCommand(parsed);
    if (response) out(response);
  } catch (e) {
    // A command that throws must not take the host — or any other session —
    // down; it is reported as this command's failure and the loop continues.
    out(fail(parsed?.id, parsed?.type ?? "unknown", e?.message ?? String(e)));
  }
}

// Commands are serialized: two `open_session` calls for the same path must not
// interleave, or both would build an AgentSession over the same jsonl. Prompts
// are not affected — `prompt` returns as soon as preflight answers, and the
// turn itself runs concurrently with everything else.
//
// Provider auth gets its own queue rather than sharing that one. It still needs
// serializing among itself — two `auth_models_put`s must not interleave their
// read-modify-write of `models.json` — but `auth_refresh` awaits a network
// catalog fetch that can take many seconds, and on the shared queue that would
// stall every session command behind it, an `abort` included. The two never
// touch the same state, so nothing is lost by letting them run in parallel.
const AUTH_COMMANDS = new Set([
  "auth_list",
  "auth_login_start",
  "auth_login_cancel",
  "auth_logout",
  "auth_refresh",
  "auth_models_get",
  "auth_models_put",
  "auth_models_delete",
  "auth_prompt_response",
]);

let queue = Promise.resolve();
let authQueue = Promise.resolve();
function enqueue(line) {
  // Peeking at the type costs one parse that `handleLine` repeats. Worth it:
  // routing has to happen before the line is queued, and a line that fails to
  // parse belongs on the session queue, which is where the parse error is
  // already reported.
  let type;
  try {
    type = JSON.parse(line)?.type;
  } catch {
    type = undefined;
  }
  if (AUTH_COMMANDS.has(type)) {
    authQueue = authQueue.then(() => handleLine(line)).catch((e) => log(`auth loop error: ${e}`));
    return;
  }
  queue = queue.then(() => handleLine(line)).catch((e) => log(`command loop error: ${e}`));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  // Split on "\n" only: U+2028 and friends are legal inside JSON strings and
  // must not end a record.
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) enqueue(line);
  }
});

async function shutdown(code) {
  for (const sessionId of [...sessions.keys()]) {
    await closeSession(sessionId);
  }
  process.exit(code);
}

process.stdin.on("end", () => void shutdown(0));
for (const signal of process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"]) {
  process.on(signal, () => void shutdown(signal === "SIGHUP" ? 129 : 143));
}

// A throw inside one session's async work would otherwise kill the process and
// with it every other session in this worktree. Log and keep serving; the
// affected turn still ends, because pi surfaces its own failures as events.
process.on("uncaughtException", (e) => log(`uncaught exception: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e?.stack ?? e}`));

out({ type: "host_ready", protocol: PROTOCOL_VERSION, piVersion: pi.VERSION ?? "" });
