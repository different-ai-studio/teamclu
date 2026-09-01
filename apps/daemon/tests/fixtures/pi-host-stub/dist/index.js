/**
 * Stub of the pi SDK surface `assets/pi-host/host.mjs` consumes, for the
 * daemon's hermetic host integration test (`pi_rpc/host_tests.rs`). No
 * network, no models, no real agent loop — just enough behavior to prove the
 * host's session multiplexing:
 *
 * - `prompt` runs an asynchronous fake turn: `agent_start`, a few
 *   `message_update` text deltas spread over timers (so concurrent sessions
 *   interleave), then `agent_end`. A prompt containing "ask" first raises a
 *   `ctx.ui.confirm` — exercising the per-session extension UI channel.
 * - `abort` settles the running fake turn immediately (its remaining deltas
 *   are dropped, `agent_end` still fires) without touching other sessions.
 * - `SessionManager.open` fails on a missing file, like the real one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const VERSION = "0.0.0-stub";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseFrontmatterField(text, field) {
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function loadSkillsFromAgentsDir() {
  const root = process.env.TEAMCLU_PI_STUB_SKILLS_ROOT;
  if (!root) return [];
  if (!fs.existsSync(root)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const text = fs.readFileSync(skillMd, "utf8");
    skills.push({
      name: parseFrontmatterField(text, "name") ?? entry.name,
      description: parseFrontmatterField(text, "description") ?? "",
    });
  }
  return skills;
}

function stubSkillsFallback() {
  return [{ name: "stub-skill", description: "A stub skill" }];
}

export class SessionManager {
  constructor(cwd, file, entries = []) {
    this.cwd = cwd;
    this.file = file;
    this.entries = entries;
  }

  static create(cwd, sessionDir) {
    const id = crypto.randomUUID();
    const file = path.join(sessionDir ?? cwd, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: "header", id })}\n`);
    return new SessionManager(cwd, file);
  }

  static open(file, _sessionDir) {
    if (!fs.existsSync(file)) {
      throw new Error(`Session file not found: ${file}`);
    }
    return new SessionManager(process.cwd(), file);
  }

  getCwd() {
    return this.cwd;
  }
  getSessionFile() {
    return this.file;
  }
  getSessionId() {
    return path.basename(this.file, ".jsonl");
  }
  getLeafId() {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].id : null;
  }
  getEntries() {
    return this.entries;
  }

  createBranchedSession(leafId) {
    const idx = this.entries.findIndex((e) => e.id === leafId);
    const subset = idx >= 0 ? this.entries.slice(0, idx + 1) : [...this.entries];
    const newFile = path.join(
      path.dirname(this.file),
      `branch-${crypto.randomUUID()}.jsonl`,
    );
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    const header = { type: "header", id: path.basename(newFile, ".jsonl") };
    fs.writeFileSync(
      newFile,
      [JSON.stringify(header), ...subset.map((e) => JSON.stringify(e))].join("\n") + "\n",
    );
    return new SessionManager(this.cwd, newFile, subset);
  }
}

export async function createAgentSessionServices(options) {
  return {
    cwd: options.cwd,
    agentDir: "",
    modelRuntime: {
      getAvailableSnapshot: () => [
        { provider: "stub", id: "stub-model", name: "Stub Model" },
        { provider: "stub", id: "stub-mini", name: "Stub Mini" },
      ],
    },
    settingsManager: {
      getGlobalSettings: () => ({}),
      getHttpIdleTimeoutMs: () => 0,
    },
    resourceLoader: {
      getSkills: () => {
        const scanned = loadSkillsFromAgentsDir();
        return {
          skills: scanned.length > 0 ? scanned : stubSkillsFallback(),
        };
      },
    },
    diagnostics: [],
  };
}

class StubAgentSession {
  constructor(services, sessionManager) {
    this.sessionManager = sessionManager;
    this.modelRuntime = services.modelRuntime;
    this.resourceLoader = services.resourceLoader;
    this.listeners = new Set();
    this.aborted = false;
    this.running = false;
    this.disposed = false;
    this.ui = undefined;
    this._model = { provider: "stub", id: "stub-model" };
    this.extensionRunner = {
      getRegisteredCommands: () => [
        { invocationName: "stub-cmd", description: "A stub extension command" },
      ],
    };
    this.promptTemplates = [];
    this.messages = [];
  }

  get model() {
    return this._model;
  }
  get thinkingLevel() {
    return "off";
  }
  get isStreaming() {
    return this.running;
  }
  get isCompacting() {
    return false;
  }
  get steeringMode() {
    return "all";
  }
  get followUpMode() {
    return "all";
  }
  get sessionFile() {
    return this.sessionManager.getSessionFile();
  }
  get sessionId() {
    return this.sessionManager.getSessionId();
  }
  get sessionName() {
    return undefined;
  }
  get autoCompactionEnabled() {
    return false;
  }
  get pendingMessageCount() {
    return 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async bindExtensions(bindings) {
    this.ui = bindings.uiContext;
  }

  async prompt(text, options) {
    options?.preflightResult?.(true);
    this.running = true;
    this.aborted = false;
    void this.runTurn(text);
  }

  async runTurn(text) {
    this.emit({ type: "agent_start" });
    if (text.includes("ask") && this.ui) {
      // Exercise the per-session UI channel: the reply's arrival (or a
      // cancel) gates the rest of the turn.
      const confirmed = await this.ui.confirm("Proceed?", `question for ${this.sessionId}`);
      this.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: confirmed ? "confirmed:" : "denied:",
          contentIndex: 0,
        },
      });
    }
    const chunks = ["echo:", text, "!"];
    for (const chunk of chunks) {
      if (this.aborted) break;
      await sleep(text.includes("slow") ? 60 : 15);
      if (this.aborted) break;
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: chunk, contentIndex: 0 },
      });
    }
    this.running = false;
    this.emit({ type: "agent_end", aborted: this.aborted });
  }

  async abort() {
    this.aborted = true;
  }

  async waitForIdle() {}

  async setModel(model) {
    this._model = model;
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}

export async function createAgentSessionFromServices(options) {
  return {
    session: new StubAgentSession(options.services, options.sessionManager),
    extensionsResult: { extensions: [], errors: [] },
  };
}
