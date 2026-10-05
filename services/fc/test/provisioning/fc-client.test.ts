import { originJwks, type OriginAuthConfig } from "../../src/lib/apps-origin-auth.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFcOps, fcEndpoint, accountIdFromRoleArn, readAppsFcVpcConfig } from "../../src/lib/provisioning/fc-client.js";

const TARGET = { appId: "76af539e-5341-4e96-bda7-6c8dacf2b092", slug: "app-a" };
const DOMAIN = "app-a-76af539e.origins.test";
const ORIGIN: OriginAuthConfig = {
  activeKey: { version: "v2", masterKey: Buffer.alloc(32, 42) },
  previousKey: { version: "v1", masterKey: Buffer.alloc(32, 43) },
  routeDomain: "origins.test",
};
function protectedTrigger(name = "http") {
  return { triggerName: name, triggerType: "http", triggerConfig: JSON.stringify({ disableURLInternet: true, authType: "anonymous", methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"] }) };
}
function protectedDomain(domainName = DOMAIN, functionName = "tc-app-1") {
  return { domainName, protocol: "HTTP", routeConfig: { routes: [{ path: "/*", functionName, qualifier: "LATEST" }] },
    authConfig: { authType: "jwt", authInfo: JSON.stringify({ jwks: originJwks(ORIGIN, TARGET.appId), tokenLookup: "header:X-Teamclu-Origin-Authorization:Bearer " }) } };
}
const OPS_CONFIG = { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN };
test('readback rejects a Bearer prefix that would leave a space in the extracted JWT', async () => {
  const domain = protectedDomain();
  const info = JSON.parse(domain.authConfig.authInfo);
  info.tokenLookup = 'header:X-Teamclu-Origin-Authorization:Bearer';
  domain.authConfig.authInfo = JSON.stringify(info);
  const { client } = fakeClient({ getCustomDomain: async () => ({ body: domain }) });
  const result = await makeFcOps(client, OPS_CONFIG).readOriginSecurity('tc-app-1', DOMAIN, TARGET);
  assert.equal(result.status, 'drift');
  assert.ok(result.driftFields.includes('authConfig.TokenLookup'));
});
test('uppercase JWT configuration is not accepted as protected provider readback', async () => {
  const domain = protectedDomain();
  domain.authConfig.authInfo = JSON.stringify({
    JWKS: originJwks(ORIGIN, TARGET.appId),
    TokenLookup: 'header:X-Teamclu-Origin-Authorization:Bearer',
    ClaimPassBy: '',
  });
  const { client } = fakeClient({ getCustomDomain: async () => ({ body: domain }) });
  const result = await makeFcOps(client, OPS_CONFIG).readOriginSecurity('tc-app-1', DOMAIN, TARGET);
  assert.equal(result.status, 'drift');
  assert.ok(result.driftFields.includes('authConfig.JWKS'));
  assert.ok(result.driftFields.includes('authConfig.TokenLookup'));
});
test('managed HTTP domain uses JWT without requiring a certificate', async () => {
  const { client, calls } = fakeClient();
  const endpoint = await makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET);
  assert.equal(endpoint, `http://${DOMAIN}`);
  const body = calls.find(c => c[0] === 'createCustomDomain')?.[1].body;
  assert.equal(body.protocol, 'HTTP');
  assert.equal(body.certConfig, undefined);
  assert.equal(body.authConfig.authType, 'jwt');
  assert.deepEqual(Object.keys(JSON.parse(body.authConfig.authInfo)).sort(), ['jwks', 'tokenLookup']);
});

const NODE_DECL = {
  build: { kind: "node" as const, output: ".output" },
  start: {
    fcRuntime: "custom.debian10",
    command: ["/opt/nodejs20/bin/node"],
    args: ["server/index.mjs"],
    port: 9000,
    layers: ["Nodejs20:3"],
  },
};

function fakeClient(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const base = {
    async getFunction(name: string) { calls.push(["getFunction", name]); return { body: { functionName: name } }; },
    async createFunction(req: any) { calls.push(["createFunction", req]); return { body: {} }; },
    async updateFunction(name: string, req: any) { calls.push(["updateFunction", name, req]); return { body: {} }; },
    async createTrigger(name: string, req: any) { calls.push(["createTrigger", name, req]); return { body: {} }; },
    async updateTrigger(name: string, trig: string, req: any) { calls.push(["updateTrigger", name, trig, req]); return { body: {} }; },
    async getTrigger(name: string, trig: string) { calls.push(["getTrigger", name, trig]); return { body: protectedTrigger() }; },
    async getCustomDomain(name: string) { calls.push(["getCustomDomain", name]); return { body: protectedDomain(name) }; },
    async createCustomDomain(req: any) { calls.push(["createCustomDomain", req]); return { body: {} }; },
    async updateCustomDomain(name: string, req: any) { calls.push(["updateCustomDomain", name, req]); return { body: {} }; },
    async listTriggers(name: string, req: any) { calls.push(["listTriggers", name, req]); return { body: { triggers: [protectedTrigger()] } }; },
    async listCustomDomains(req: any) { calls.push(["listCustomDomains", req]); return { body: { customDomains: [protectedDomain()] } }; },
  };
  return { client: { ...base, ...overrides }, calls };
}

test("ensureFunction creates when GetFunction 404s", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "createFunction"));
  assert.ok(!calls.some((c) => c[0] === "updateFunction"));
});

test("ensureFunction updates code when the function already exists", async () => {
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "updateFunction"));
  assert.ok(!calls.some((c) => c[0] === "createFunction"));
});

test("ensureFunction passes the declared FC runtime and start config through on create", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.equal(create.runtime, NODE_DECL.start.fcRuntime);
  assert.deepEqual(create.customRuntimeConfig.command, NODE_DECL.start.command);
  assert.deepEqual(create.customRuntimeConfig.args, NODE_DECL.start.args);
  assert.equal(create.customRuntimeConfig.port, NODE_DECL.start.port);
  assert.deepEqual(create.layers, ["acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/3"]);
});

test("an explicit empty layers list attaches no layer", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", {
    declaration: { ...NODE_DECL, start: { ...NODE_DECL.start, layers: [] } },
    ossObjectName: "apps/1/code.zip",
    env: {},
  });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.deepEqual(create.layers, []);
});

test("a python declaration gets its declared Python layer and command", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  const declaration = {
    build: { kind: "python" as const, output: "." },
    start: { fcRuntime: "custom.debian12", command: ["python3"], args: ["app.py"], port: 8080, layers: ["Python310:3"] },
  };
  await ops.ensureFunction("tc-app-1", { declaration, ossObjectName: "apps/1/code.zip", env: {} });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.equal(create.runtime, "custom.debian12");
  assert.deepEqual(create.customRuntimeConfig.command, ["python3"]);
  assert.deepEqual(create.customRuntimeConfig.args, ["app.py"]);
  assert.deepEqual(create.layers, ["acs:fc:cn-shenzhen:official:layers/Python310/versions/3"]);
});

test("ensureFunction re-sends the layer and start command on the update path", async () => {
  // Functions created before the layer existed boot with a command that cannot
  // resolve. A code-only update would leave them broken through every redeploy
  // the user tries — the update has to repair the config, not just the code.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  const declaration = {
    ...NODE_DECL,
    start: {
      fcRuntime: "custom.debian12",
      command: ["/bin/sh"],
      args: ["start-server"],
      port: 8081,
      layers: [],
    },
  };
  await ops.ensureFunction("tc-app-1", { declaration, ossObjectName: "apps/1/code.zip", env: { PORT: "8081" } });
  const upd = calls.find((c) => c[0] === "updateFunction")[2].body;
  assert.equal(upd.runtime, "custom.debian12");
  assert.deepEqual(upd.customRuntimeConfig.command, ["/bin/sh"]);
  assert.deepEqual(upd.customRuntimeConfig.args, ["start-server"]);
  assert.equal(upd.customRuntimeConfig.port, 8081);
  assert.deepEqual(upd.layers, []);
});

test("ensureFunction re-sends environmentVariables on the update path", async () => {
  // A redeploy rotates the app's DB password, so the env must be rewritten
  // alongside the code rather than assumed to survive.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", {
    declaration: NODE_DECL,
    ossObjectName: "apps/1/code.zip",
    env: { PORT: "9000", DATABASE_URL: "postgres://app_x:new-pw@h/teamclu_apps" },
  });
  const upd = calls.find((c) => c[0] === "updateFunction");
  assert.ok(upd, "updateFunction was called");
  assert.equal(upd[2].body.environmentVariables.DATABASE_URL, "postgres://app_x:new-pw@h/teamclu_apps");
});

test("ensureFunction attaches VPC config on create and update when configured", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const vpc = { vpcId: "vpc-apps", vSwitchIds: ["vsw-apps"], securityGroupId: "sg-apps" };
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", vpc });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.equal(create.vpcConfig.vpcId, "vpc-apps");
  assert.deepEqual(create.vpcConfig.vSwitchIds, ["vsw-apps"]);
  assert.equal(create.vpcConfig.securityGroupId, "sg-apps");
  assert.equal(create.internetAccess, true);

  const { client: existing, calls: updateCalls } = fakeClient();
  const ops2 = makeFcOps(existing as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", vpc });
  await ops2.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const upd = updateCalls.find((c) => c[0] === "updateFunction")[2].body;
  assert.equal(upd.vpcConfig.vpcId, "vpc-apps");
});

test("readAppsFcVpcConfig requires all three variables together", () => {
  const prev = {
    vpc: process.env.APPS_FC_VPC_ID,
    vsw: process.env.APPS_FC_VSWITCH_ID,
    sg: process.env.APPS_FC_SECURITY_GROUP_ID,
  };
  delete process.env.APPS_FC_VPC_ID;
  delete process.env.APPS_FC_VSWITCH_ID;
  delete process.env.APPS_FC_SECURITY_GROUP_ID;
  try {
    assert.equal(readAppsFcVpcConfig(), undefined);
    process.env.APPS_FC_VPC_ID = "vpc-1";
    assert.throws(() => readAppsFcVpcConfig(), /must all be set together/);
    process.env.APPS_FC_VSWITCH_ID = "vsw-1";
    process.env.APPS_FC_SECURITY_GROUP_ID = "sg-1";
    assert.deepEqual(readAppsFcVpcConfig(), {
      vpcId: "vpc-1",
      vSwitchIds: ["vsw-1"],
      securityGroupId: "sg-1",
    });
  } finally {
    for (const [k, v] of [
      ["APPS_FC_VPC_ID", prev.vpc],
      ["APPS_FC_VSWITCH_ID", prev.vsw],
      ["APPS_FC_SECURITY_GROUP_ID", prev.sg],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("accountIdFromRoleArn reads the account out of a RAM role ARN", () => {
  assert.equal(accountIdFromRoleArn("acs:ram::1234567890123456:role/teamclu-oss"), "1234567890123456");
  assert.equal(accountIdFromRoleArn("  acs:ram::123456789:role/x  "), "123456789");
  assert.equal(accountIdFromRoleArn("acs:ram::notanumber:role/x"), null);
  assert.equal(accountIdFromRoleArn("garbage"), null);
  assert.equal(accountIdFromRoleArn(undefined), null);
});

test("fcEndpoint resolves explicit host, then account id, then ROLE_ARN", () => {
  const prev = {
    endpoint: process.env.APPS_FC_ENDPOINT,
    account: process.env.ALIYUN_ACCOUNT_ID,
    role: process.env.ROLE_ARN,
  };
  delete process.env.APPS_FC_ENDPOINT;
  delete process.env.ALIYUN_ACCOUNT_ID;
  delete process.env.ROLE_ARN;
  try {
    // Previously composed the literal host "undefined.<region>.fc.aliyuncs.com".
    assert.throws(() => fcEndpoint(), /APPS_FC_ENDPOINT, ALIYUN_ACCOUNT_ID, or a ROLE_ARN/);

    // Any deployment that can reach OSS already has ROLE_ARN, so app deploys
    // need no new configuration.
    process.env.ROLE_ARN = "acs:ram::1234567890123456:role/teamclu-oss";
    assert.match(fcEndpoint(), /^1234567890123456\..*\.fc\.aliyuncs\.com$/);

    process.env.ALIYUN_ACCOUNT_ID = "999";
    assert.match(fcEndpoint(), /^999\./, "explicit account id beats the ARN");

    process.env.APPS_FC_ENDPOINT = "https://explicit.example";
    assert.equal(fcEndpoint(), "https://explicit.example", "explicit host wins outright");
  } finally {
    for (const [k, v] of [["APPS_FC_ENDPOINT", prev.endpoint], ["ALIYUN_ACCOUNT_ID", prev.account], ["ROLE_ARN", prev.role]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("fcEndpoint composes the host from the APPS region, not the default one", () => {
  // On self-host REGION labels the MinIO client; the function lives wherever
  // its code bucket is. Composing the host from REGION would aim every FC call
  // at a region that holds no function at all.
  const prev = { region: process.env.REGION, apps: process.env.APPS_REGION, account: process.env.ALIYUN_ACCOUNT_ID, endpoint: process.env.APPS_FC_ENDPOINT };
  delete process.env.APPS_FC_ENDPOINT;
  process.env.ALIYUN_ACCOUNT_ID = "1234567890123456";
  process.env.REGION = "cn-shenzhen";
  try {
    assert.equal(fcEndpoint(), "1234567890123456.cn-shenzhen.fc.aliyuncs.com");
    process.env.APPS_REGION = "cn-hangzhou";
    assert.equal(fcEndpoint(), "1234567890123456.cn-hangzhou.fc.aliyuncs.com");
  } finally {
    for (const [k, v] of [["REGION", prev.region], ["APPS_REGION", prev.apps], ["ALIYUN_ACCOUNT_ID", prev.account], ["APPS_FC_ENDPOINT", prev.endpoint]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("ensureHttpTrigger disables the public URL without requiring urlInternet", async () => {
  const { client } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.deepEqual(url, { internetUrlDisabled: true });
});

test("ensureHttpTrigger allows the methods a browser actually sends", async () => {
  // The trigger refuses anything outside this list with a 403 the app never
  // sees. Leaving OPTIONS out fails every CORS preflight; leaving HEAD out
  // breaks link previews and health checks.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  await ops.ensureHttpTrigger("tc-app-1");
  const cfg = JSON.parse(calls.find((c) => c[0] === "createTrigger")[2].body.triggerConfig);
  for (const m of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"]) {
    assert.ok(cfg.methods.includes(m), `${m} must be allowed`);
  }
});

test("ensureHttpTrigger repairs an existing trigger's method list", async () => {
  // Triggers made before OPTIONS was allowed keep refusing it: createTrigger is
  // a no-op for them, so a redeploy has to update the config explicitly.
  const conflict = Object.assign(new Error("exists"), { statusCode: 409, code: "TriggerAlreadyExists" });
  const { client, calls } = fakeClient({ createTrigger: async () => { throw conflict; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  await ops.ensureHttpTrigger("tc-app-1");
  const upd = calls.find((c) => c[0] === "updateTrigger");
  assert.ok(upd, "an existing trigger must be updated, not silently left alone");
  assert.ok(JSON.parse(upd[3].body.triggerConfig).methods.includes("OPTIONS"));
});

test("ensureHttpTrigger updates an existing trigger then verifies protection", async () => {
  const conflict = Object.assign(new Error("exists"), { statusCode: 409, code: "TriggerAlreadyExists" });
  const { client } = fakeClient({ createTrigger: async () => { throw conflict; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.deepEqual(url, { internetUrlDisabled: true });
});

test("ensureHttpTrigger recovers when FC cannot read a newly created trigger yet", async () => {
  const missing = Object.assign(new Error("trigger not found"), { statusCode: 404, code: "TriggerNotFound" });
  const exists = Object.assign(new Error("trigger exists"), { statusCode: 409, code: "TriggerAlreadyExists" });
  let created = false;
  let reads = 0;
  const { client } = fakeClient({
    createTrigger: async () => {
      if (created) throw exists;
      created = true;
      return { body: {} };
    },
    getTrigger: async () => {
      reads++;
      if (reads === 1) throw missing;
      return { body: protectedTrigger() };
    },
  });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  assert.deepEqual(await ops.ensureHttpTrigger("tc-app-1"), { internetUrlDisabled: true });
  assert.equal(reads, 2);
});

test("ensureHttpTrigger recovers when FC initially rejects trigger creation after function creation", async () => {
  const missing = Object.assign(new Error("trigger not found"), { statusCode: 404, code: "TriggerNotFound" });
  let attempts = 0;
  const { client } = fakeClient({
    createTrigger: async () => {
      attempts++;
      if (attempts === 1) throw missing;
      return { body: {} };
    },
  });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  assert.deepEqual(await ops.ensureHttpTrigger("tc-app-1"), { internetUrlDisabled: true });
  assert.equal(attempts, 2);
});

test("ensureHttpTrigger fails after bounded retries when the trigger stays missing", async () => {
  const missing = Object.assign(new Error("trigger not found"), { statusCode: 404, code: "TriggerNotFound" });
  let attempts = 0;
  const { client } = fakeClient({ createTrigger: async () => { attempts++; throw missing; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  await assert.rejects(ops.ensureHttpTrigger("tc-app-1"), /TriggerNotFound/);
  assert.ok(attempts > 1 && attempts <= 5, `expected bounded retry, got ${attempts} attempts`);
});

test("ensureCustomDomain recovers when FC has not recognized the verified HTTP trigger yet", async () => {
  const missing = Object.assign(new Error("trigger not found"), { statusCode: 404, code: "TriggerNotFound" });
  let attempts = 0;
  const { client } = fakeClient({
    createCustomDomain: async () => {
      attempts++;
      if (attempts === 1) throw missing;
      return { body: {} };
    },
  });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  assert.equal(await ops.ensureCustomDomain("tc-app-1", DOMAIN, TARGET), `http://${DOMAIN}`);
  assert.equal(attempts, 2);
});

test("ensureCustomDomain fails after bounded retries when FC never recognizes the trigger", async () => {
  const missing = Object.assign(new Error("trigger not found"), { statusCode: 404, code: "TriggerNotFound" });
  let attempts = 0;
  const { client } = fakeClient({ createCustomDomain: async () => { attempts++; throw missing; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", originAuth: ORIGIN });
  await assert.rejects(ops.ensureCustomDomain("tc-app-1", DOMAIN, TARGET), /TriggerNotFound/);
  assert.ok(attempts > 1 && attempts <= 5, `expected bounded retry, got ${attempts} attempts`);
});

// --- log delivery -----------------------------------------------------------

const LOGS = { project: "teamclu-apps-1", logstore: "app-logs" };

test("a new function is created with its log config", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: undefined, region: "cn-shenzhen", logs: () => LOGS });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: {} });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.equal(create.logConfig.project, "teamclu-apps-1");
  assert.equal(create.logConfig.logstore, "app-logs");
  // Without this there is no per-request row, and "did the request even arrive"
  // has no answer.
  assert.equal(create.logConfig.enableRequestMetrics, true);
});

test("an existing function gets its log config re-sent on every update", async () => {
  // The nine functions deployed before log delivery existed carry an empty log
  // config. A code-only update would leave them with no logs forever, however
  // many times their owner redeployed — the same trap the Node layer and the
  // VPC config were both fixed for.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: undefined, region: "cn-shenzhen", logs: () => LOGS });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: {} });
  const update = calls.find((c) => c[0] === "updateFunction")[2].body;
  assert.equal(update.logConfig.project, "teamclu-apps-1");
  assert.equal(update.logConfig.logstore, "app-logs");
});

test("a deployment with no usable log store deploys without a log config", async () => {
  // Not an empty project/logstore pair: Function Compute rejects a logConfig
  // naming a project that does not exist, which would turn "logs are not set
  // up" into "this app cannot deploy at all".
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: undefined, region: "cn-shenzhen", logs: () => undefined });
  await ops.ensureFunction("tc-app-1", { declaration: NODE_DECL, ossObjectName: "apps/1/code.zip", env: {} });
  const update = calls.find((c) => c[0] === "updateFunction")[2].body;
  assert.equal(update.logConfig, undefined);
});

// --- Container apps

const CONTAINER = {
  build: { kind: "container" as const, output: ".", dockerfile: "Dockerfile", context: "." },
  start: { port: 5000 },
};

test("a container app runs its own image, with no layer and no code object", async () => {
  // Sending either alongside customContainerConfig is how a Node layer ends up
  // mounted into someone's Python image, and how a function keeps pointing at
  // a code.zip that this deploy never wrote.
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", {
    ossObjectName: "apps/1/code.zip",
    env: { PORT: "5000" },
    declaration: CONTAINER,
    image: "registry.cn-shenzhen.aliyuncs.com/ns/tc-app-1:abc1234",
  });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.equal(create.runtime, "custom-container");
  assert.equal(create.customContainerConfig.image, "registry.cn-shenzhen.aliyuncs.com/ns/tc-app-1:abc1234");
  assert.equal(create.customContainerConfig.port, 5000);
  assert.equal(create.customContainerConfig.command, undefined);
  assert.equal(create.customContainerConfig.args, undefined);
  assert.equal(create.layers, undefined);
  assert.equal(create.code, undefined);
  assert.equal(create.customRuntimeConfig, undefined);
});

test("a redeploy re-sends the image, not just the environment", async () => {
  // Same reason the layer and the start command are re-sent: a function that
  // only got its image at create would keep running the first one forever, and
  // the redeploy a user reaches for would report success and change nothing.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", {
    ossObjectName: "apps/1/code.zip",
    env: {},
    declaration: CONTAINER,
    image: "registry/ns/tc-app-1:second",
  });
  const update = calls.find((c) => c[0] === "updateFunction")[2].body;
  assert.equal(update.runtime, "custom-container");
  assert.equal(update.customContainerConfig.image, "registry/ns/tc-app-1:second");
  assert.equal(update.layers, undefined);
});

test("a container app with a declared health path gets a check that survives a cold pull", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", {
    ossObjectName: "apps/1/code.zip",
    env: {},
    declaration: { ...CONTAINER, start: { ...CONTAINER.start, healthCheckPath: "/api/health" } },
    image: "registry/ns/tc-app-1:abc",
  });
  const cfg = calls.find((c) => c[0] === "createFunction")[1].body.customContainerConfig;
  assert.equal(cfg.healthCheckConfig.httpGetUrl, "/api/health");
  assert.ok(
    cfg.healthCheckConfig.initialDelaySeconds >= 10,
    "a first pull of an emulated-build image is slow",
  );
});

test("a container app cannot be finalized without the image the build pushed", async () => {
  const { client } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await assert.rejects(
    () => ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: {}, declaration: CONTAINER }),
    /must be finalized with the image/,
  );
});

test("a declaration is required instead of silently defaulting to node", async () => {
  const { client } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await assert.rejects(
    () => ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: {} }),
    /declaration \(build\+start\) is required/,
  );
});

for (const existing of [false, true]) {
  test(`trigger ${existing ? 'update' : 'create'} disables internet URL`, async () => {
    const { client, calls } = fakeClient(existing ? { createTrigger: async () => { throw { code: 'TriggerAlreadyExists' }; } } : {});
    const result = await makeFcOps(client, OPS_CONFIG).ensureHttpTrigger('tc-app-1');
    const c = calls.find(c => c[0] === (existing ? 'updateTrigger' : 'createTrigger'));
    assert.equal(JSON.parse(c[existing ? 3 : 2].body.triggerConfig).disableURLInternet, true);
    assert.deepEqual(result, { internetUrlDisabled: true });
  });
  test(`domain ${existing ? 'update' : 'create'} sends HTTP app JWT`, async () => {
    const { client, calls } = fakeClient(existing ? { createCustomDomain: async () => { throw { code: 'CustomDomainAlreadyExists' }; } } : {});
    assert.equal(await makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), `http://${DOMAIN}`);
    const c = calls.find(c => c[0] === (existing ? 'updateCustomDomain' : 'createCustomDomain'));
    const body = c[existing ? 2 : 1].body;
    assert.equal(JSON.parse(body.authConfig.authInfo).tokenLookup, 'header:X-Teamclu-Origin-Authorization:Bearer ');
    assert.equal(body.protocol, 'HTTP'); assert.equal(body.certConfig, undefined);
    assert.equal(Object.hasOwn(JSON.parse(body.authConfig.authInfo), 'claimPassBy'), false, 'FC rejects an empty claim mapping; omit the field');
    assert.equal(body.authConfig.authType, 'jwt'); assert.deepEqual(JSON.parse(body.authConfig.authInfo), JSON.parse(protectedDomain().authConfig.authInfo));
  });
}
for (const value of [false, undefined]) {
  test(`trigger readback rejects disableURLInternet ${value}`, async () => {
    const { client } = fakeClient({ getTrigger: async () => ({ body: { triggerConfig: JSON.stringify({ disableURLInternet: value }) } }) });
    await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureHttpTrigger('tc-app-1'), /disableURLInternet/);
  });
}
const driftCases: Array<[string, (d: any) => void]> = [
  ['protocol', d => { d.protocol = 'HTTP,HTTPS'; }],
  ['protocol', d => { d.protocol = 'HTTPS'; }],
  ['routeConfig', d => { d.routeConfig.routes[0].functionName = 'other-function'; }],
  ['routeConfig', d => { delete d.routeConfig; }],
  ['authConfig.authType', d => { d.authConfig.authType = 'anonymous'; }],
  ['authConfig.JWKS', d => { const a = JSON.parse(d.authConfig.authInfo); a.jwks.keys[0].k = 'secret-wrong-key'; d.authConfig.authInfo = JSON.stringify(a); }],
  ['authConfig.JWKS', d => { const a = JSON.parse(d.authConfig.authInfo); a.jwks.keys.push({ ...a.jwks.keys[0], kid: 'extra' }); d.authConfig.authInfo = JSON.stringify(a); }],
  ['authConfig.TokenLookup', d => { const a = JSON.parse(d.authConfig.authInfo); a.tokenLookup += ',cookie:token'; d.authConfig.authInfo = JSON.stringify(a); }],
  ['authConfig.ClaimPassBy', d => { const a = JSON.parse(d.authConfig.authInfo); a.claimPassBy = 'header:sub:X-Teamclu-User'; d.authConfig.authInfo = JSON.stringify(a); }],
  ['authConfig.authInfo', d => { delete d.authConfig.authInfo; }],
];
for (const [field, change] of driftCases) {
  test(`domain readback rejects drift in ${field}`, async () => {
    const domain = protectedDomain(); change(domain);
    const { client } = fakeClient({ getCustomDomain: async () => ({ body: domain }) });
    await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), e => String(e).includes(field) && !String(e).includes('secret-wrong'));
  });
}
test('semantic comparison accepts key ordering, header casing and provider defaults', async () => {
  const d = protectedDomain(), a = JSON.parse(d.authConfig.authInfo); a.jwks.keys.reverse();
  d.authConfig.authInfo = JSON.stringify({ tokenLookup: 'header:x-teamclu-origin-authorization:Bearer ', jwks: a.jwks });
  const { client } = fakeClient({ getCustomDomain: async () => ({ body: { ...d, createdTime: 'default' } }) });
  assert.equal(await makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), `http://${DOMAIN}`);
});
test('rejects second-page anonymous trigger without mutating extra triggers', async () => {
  const { client, calls } = fakeClient({ listTriggers: async (_: string, r: any) => ({ body: r.nextToken ? { triggers: [{ ...protectedTrigger('extra'), triggerConfig: '{"authType":"anonymous","disableURLInternet":false}' }] } : { triggers: [protectedTrigger()], nextToken: 'next' } }) });
  await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), /extraHttpTriggers/);
  assert.ok(!calls.some(c => c[0] === 'updateTrigger'));
});
test('single-item lists still traverse every page before accepting origin security', async () => {
  const triggerTokens: (string | undefined)[] = [], domainTokens: (string | undefined)[] = [];
  const { client } = fakeClient({
    listTriggers: async (_: string, r: any) => {
      assert.equal(r.limit, 1);
      triggerTokens.push(r.nextToken);
      return { body: r.nextToken ? { triggers: [] } : { triggers: [protectedTrigger()], nextToken: 'trigger-page-2' } };
    },
    listCustomDomains: async (r: any) => {
      assert.equal(r.limit, 1);
      domainTokens.push(r.nextToken);
      return { body: r.nextToken ? { customDomains: [{ domainName: 'other.example.com', routeConfig: { routes: [{ functionName: 'other' }] } }] } : { customDomains: [protectedDomain()], nextToken: 'domain-page-2' } };
    },
  });
  assert.equal(await makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), `http://${DOMAIN}`);
  assert.deepEqual(triggerTokens, [undefined, 'trigger-page-2']);
  assert.deepEqual(domainTokens, [undefined, 'domain-page-2']);
});
for (const mode of ['anonymous', 'protected', 'other-app-key']) {
  test(`checks second-page ${mode} alias without mutating unrelated functions`, async () => {
    const alias = protectedDomain('alias.origins.test');
    if (mode === 'anonymous') alias.authConfig.authType = 'anonymous';
    if (mode === 'other-app-key') { const a = JSON.parse(alias.authConfig.authInfo); a.jwks = originJwks(ORIGIN, '11111111-2222-4333-8444-555555555555'); alias.authConfig.authInfo = JSON.stringify(a); }
    const { client, calls } = fakeClient({
      listCustomDomains: async (r: any) => ({ body: r.nextToken ? { customDomains: [alias] } : { customDomains: [protectedDomain(), { domainName: 'other.example.com', routeConfig: { routes: [{ functionName: 'other' }] } }], nextToken: 'next' } }),
      getCustomDomain: async (n: string) => ({ body: n === alias.domainName ? alias : protectedDomain(n) }),
    });
    const run = makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET);
    if (mode === 'protected') assert.equal(await run, `http://${DOMAIN}`); else await assert.rejects(run, /customDomainAliases/);
    assert.equal(calls.filter(c => c[0] === 'createCustomDomain').length, 1); assert.ok(!calls.some(c => c[0] === 'updateCustomDomain'));
  });
}
for (const operation of ['getTrigger', 'getCustomDomain', 'listTriggers', 'listCustomDomains']) {
  test(`${operation} errors are sanitized and read-only status unavailable`, async () => {
    const error = Object.assign(new Error(`secret ${"test-private-secret"}`), { code: 'AccessDenied', request: { key: "test-private-secret" } });
    const { client, calls } = fakeClient({ [operation]: async () => { throw error; } });
    const ops = makeFcOps(client, OPS_CONFIG), summary = await ops.readOriginSecurity('tc-app-1', DOMAIN, TARGET);
    assert.equal(summary.status, 'unavailable'); assert.ok(summary.driftFields.includes(operation)); assert.ok(!JSON.stringify(summary).includes('secret'));
    assert.ok(!calls.some(c => /^(create|update)/.test(c[0])));
    await assert.rejects(ops.ensureCustomDomain('tc-app-1', DOMAIN, TARGET), e => !String(e).includes('secret') && !String(e).includes("test-private-secret"));
  });
}
for (const operation of ['listTriggers', 'listCustomDomains']) {
  test(`${operation} missing list or cyclic page fails closed`, async () => {
    for (const body of [{}, { [operation === 'listTriggers' ? 'triggers' : 'customDomains']: [], nextToken: 'repeat' }]) {
      const { client } = fakeClient({ [operation]: async () => ({ body }) });
      assert.equal((await makeFcOps(client, OPS_CONFIG).readOriginSecurity('tc-app-1', DOMAIN, TARGET)).status, 'unavailable');
    }
  });
}
test('missing routing in domain list fails closed', async () => {
  const { client } = fakeClient({ listCustomDomains: async () => ({ body: { customDomains: [{ domainName: 'unknown.origins.test' }] } }) });
  await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), /listCustomDomains/);
});
test('missing config blocks entrypoint operations but not function deletion', async () => {
  const { client, calls } = fakeClient({ deleteFunction: async () => { calls.push(['deleteFunction']); } });
  const ops = makeFcOps(client, { ...OPS_CONFIG, originAuth: undefined });
  await assert.rejects(ops.ensureHttpTrigger('tc-app-1'), /originAuth/); await assert.rejects(ops.ensureCustomDomain('tc-app-1', DOMAIN, TARGET), /originAuth/);
  await ops.deleteFunction('tc-app-1'); assert.ok(calls.some(c => c[0] === 'deleteFunction'));
});
for (const auth of ['disabled-anonymous', 'protected-jwt']) {
  test(`rejects non-standard ${auth} HTTP trigger without repairing it`, async () => {
    const extra = protectedTrigger('unexpected');
    if (auth === 'protected-jwt') extra.triggerConfig = JSON.stringify({ disableURLInternet: false, authType: 'jwt', authConfig: protectedDomain().authConfig.authInfo });
    const { client, calls } = fakeClient({ listTriggers: async () => ({ body: { triggers: [protectedTrigger(), extra] } }) });
    await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', DOMAIN, TARGET), /extraHttpTriggers/);
    assert.ok(!calls.some(c => c[0] === 'updateTrigger'));
  });
}
for (const operation of ['createTrigger', 'updateTrigger', 'createCustomDomain', 'updateCustomDomain']) {
  test(`${operation} management failures cannot expose JWKS or private keys`, async () => {
    const sensitive = originJwks(ORIGIN, TARGET.appId).keys[0].k;
    const bad = Object.assign(new Error(`${sensitive} ${"test-private-secret"}`), { code: 'AccessDenied', data: { request: ORIGIN } });
    const overrides: Record<string, any> = { [operation]: async () => { throw bad; } };
    if (operation.startsWith('update')) overrides[operation.replace('update', 'create')] = async () => { throw { code: 'AlreadyExists' }; };
    const { client } = fakeClient(overrides), ops = makeFcOps(client, OPS_CONFIG);
    const run = operation.includes('Trigger') ? ops.ensureHttpTrigger('tc-app-1') : ops.ensureCustomDomain('tc-app-1', DOMAIN, TARGET);
    await assert.rejects(run, error => String(error).includes('AccessDenied') && !String(error).includes(sensitive) && !String(error).includes("test-private-secret") && !(error as any).data);
  });
}
test('incomplete trigger readback fails closed', async () => {
  const { client } = fakeClient({ getTrigger: async () => ({ body: { httpTrigger: { urlInternet: 'https://unsafe.fcapp.run' } } }) });
  await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureHttpTrigger('tc-app-1'), /disableURLInternet/);
});
test('target domain mismatch fails before mutation', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', 'other.origins.test', TARGET), /domainName/);
  assert.equal(calls.length, 0);
});
test('malformed domain route reports field drift without a raw parser error', async () => {
  const domain: any = protectedDomain(); domain.routeConfig.routes = [null];
  const { client } = fakeClient({ getCustomDomain: async () => ({ body: domain }) });
  const summary = await makeFcOps(client, OPS_CONFIG).readOriginSecurity('tc-app-1', DOMAIN, TARGET);
  assert.equal(summary.status, 'drift'); assert.ok(summary.driftFields.includes('routeConfig'));
});
test('raw ASCII slug deploys on its canonical UUID-suffixed origin host', async () => {
  const { client, calls } = fakeClient();
  const host = 'app-a-76af539e.origins.test';
  assert.equal(await makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', host, TARGET), `http://${host}`);
  assert.equal(calls.find(c => c[0] === 'createCustomDomain')[1].body.domainName, host);
});
test('raw Chinese slug deploys on its canonical punycode UUID-suffixed host', async () => {
  const target = { ...TARGET, slug: '测试应用' };
  const host = 'xn---76af539e-fv0r280khztdm1e.origins.test';
  const { client, calls } = fakeClient({ listCustomDomains: async () => ({ body: { customDomains: [protectedDomain(host)] } }) });
  assert.equal(await makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', host, target), `http://${host}`);
  assert.equal(calls.find(c => c[0] === 'createCustomDomain')[1].body.domainName, host);
});
test('slug whose canonical UUID-suffixed label exceeds DNS limit is rejected before mutation', async () => {
  const slug = 'a'.repeat(56), target = { ...TARGET, slug };
  const { client, calls } = fakeClient({ listCustomDomains: async () => ({ body: { customDomains: [] } }) });
  await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', `${slug}.origins.test`, target), /domainName/);
  assert.equal(calls.length, 0);
});
test('unencodable slug is rejected as a target domain mismatch before mutation', async () => {
  const target = { ...TARGET, slug: '\uD800' }, { client, calls } = fakeClient();
  await assert.rejects(makeFcOps(client, OPS_CONFIG).ensureCustomDomain('tc-app-1', `${target.slug}.origins.test`, target), /domainName/);
  assert.equal(calls.length, 0);
});
