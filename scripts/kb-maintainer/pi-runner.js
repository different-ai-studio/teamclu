"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ensureWikiRepo, changedRelPaths, headCommit } = require("./git-store");
const { buildCompilePrompt } = require("./compile-prompt");
const { jailedWikiOperations } = require("./wiki-jail");

const ALLOWED_PI_TOOLS = ["read", "write", "edit", "find"];

function amuxdHome() {
  return process.env.AMUXD_HOME || path.join(os.homedir(), ".amuxd");
}

function loadTeamGateway(ctx) {
  if (ctx.teamProvider && ctx.gatewayToken) {
    return { provider: ctx.teamProvider, token: ctx.gatewayToken };
  }
  const raw = process.env.TEAMCLU_TEAM_PROVIDER;
  const token = process.env.tc_gateway_token;
  if (!raw || !token) {
    throw new Error(
      "Team AI gateway is not available. Open a team session once, then maintain Wiki again.",
    );
  }
  return { provider: JSON.parse(raw), token };
}

function writePiAuth(agentDir, provider, token) {
  const models = Array.isArray(provider.models) && provider.models.length > 0
    ? provider.models
    : [{ id: "default", name: "标准" }];
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          team: {
            name: provider.name || "Team",
            baseUrl: provider.baseUrl,
            api: "openai-completions",
            apiKey: token,
            models: models.map((model) => ({
              id: model.id,
              name: model.name || model.id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 16000,
            })),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(agentDir, "auth.json"),
    `${JSON.stringify({ team: { type: "api_key", key: token } }, null, 2)}\n`,
  );
}

function piPackageRoot() {
  return path.join(
    amuxdHome(),
    "cache/pi/node_modules/@earendil-works/pi-coding-agent",
  );
}

async function createLivePiSession(ctx) {
  const { provider, token } = loadTeamGateway(ctx);
  const piRoot = piPackageRoot();
  const entry = path.join(piRoot, "dist/index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      "The managed Agent runtime is not installed. Finish local Agent setup, then try again.",
    );
  }
  const sdk = await import(pathToFileURL(entry).href);
  const wikiRoot = path.join(ctx.workRoot, "wiki");
  const agentDir = path.join(ctx.workRoot, "state", "pi-agent");
  writePiAuth(agentDir, provider, token);
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const wanted = ctx.compilerModel || provider.models?.[0]?.id || "default";
  const model =
    modelRuntime.getModel("team", wanted) || modelRuntime.getModels("team")[0];
  if (!model) {
    throw new Error("Team AI compiler model is not available.");
  }
  const ops = jailedWikiOperations(ctx.workRoot);
  const { session } = await sdk.createAgentSession({
    cwd: wikiRoot,
    agentDir,
    modelRuntime,
    model,
    noTools: "all",
    customTools: [
      sdk.createReadToolDefinition(wikiRoot, { operations: ops }),
      sdk.createWriteToolDefinition(wikiRoot, { operations: ops }),
      sdk.createEditToolDefinition(wikiRoot, { operations: ops }),
      sdk.createFindToolDefinition(wikiRoot, { operations: ops }),
    ],
    sessionManager: sdk.SessionManager.inMemory(wikiRoot),
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  return session;
}

function affectedWikiPages(wikiRoot, fromCommit) {
  return changedRelPaths(wikiRoot, fromCommit).filter(
    (rel) => rel === "index.md" || rel.startsWith("index/") || rel.startsWith("pages/"),
  );
}

async function compile(ctx) {
  const wikiRoot = path.join(ctx.workRoot, "wiki");
  ensureWikiRepo(wikiRoot);
  const before = headCommit(wikiRoot);
  const prompt = buildCompilePrompt({
    ...ctx,
    indexMarkdown:
      ctx.indexMarkdown ||
      (fs.existsSync(path.join(wikiRoot, "index.md"))
        ? fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8")
        : ""),
  });
  const session = ctx.createSession
    ? await ctx.createSession(ctx)
    : await createLivePiSession(ctx);
  await session.prompt(prompt);
  if (typeof session.waitForIdle === "function") {
    await session.waitForIdle();
  }
  if (typeof session.dispose === "function") {
    await session.dispose();
  }
  return { affectedPages: affectedWikiPages(wikiRoot, before) };
}

module.exports = {
  ALLOWED_PI_TOOLS,
  compile,
  loadTeamGateway,
  createLivePiSession,
};
