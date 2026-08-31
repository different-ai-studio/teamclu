import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFcOps, fcEndpoint, accountIdFromRoleArn, NODE_BIN, nodejsLayerArn, readAppsFcVpcConfig } from "../../src/lib/provisioning/fc-client.js";

function fakeClient(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const base = {
    async getFunction(name: string) { calls.push(["getFunction", name]); return { body: { functionName: name } }; },
    async createFunction(req: any) { calls.push(["createFunction", req]); return { body: {} }; },
    async updateFunction(name: string, req: any) { calls.push(["updateFunction", name, req]); return { body: {} }; },
    async createTrigger(name: string, req: any) { calls.push(["createTrigger", name, req]); return { body: {} }; },
    async updateTrigger(name: string, trig: string, req: any) { calls.push(["updateTrigger", name, trig, req]); return { body: {} }; },
    async getTrigger(name: string, trig: string) { calls.push(["getTrigger", name, trig]); return { body: { httpTrigger: { urlInternet: "https://fn.example.fcapp.run" } } }; },
  };
  return { client: { ...base, ...overrides }, calls };
}

test("ensureFunction creates when GetFunction 404s", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "createFunction"));
  assert.ok(!calls.some((c) => c[0] === "updateFunction"));
});

test("ensureFunction updates code when the function already exists", async () => {
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "updateFunction"));
  assert.ok(!calls.some((c) => c[0] === "createFunction"));
});

test("ensureFunction points the custom runtime at the artifact's own layout", async () => {
  // The daemon zips the CONTENTS of `.output`, so the entry is `server/index.mjs`.
  // A `.output/` prefix here names a path that never exists in the package and
  // the function silently fails to boot.
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const create = calls.find((c) => c[0] === "createFunction");
  const runtimeCfg = create[1].body.customRuntimeConfig;
  assert.deepEqual(runtimeCfg.args, ["server/index.mjs"]);
  assert.equal(runtimeCfg.port, 9000);
});

test("ensureFunction starts node from the layer, by absolute path", async () => {
  // The custom runtime image has no node — a bare "node" (and even
  // `/bin/sh -c 'exec node …'`) dies at instance start with exit 127. The
  // official layer supplies one under /opt and does not touch PATH.
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.deepEqual(create.customRuntimeConfig.command, [NODE_BIN]);
  assert.match(NODE_BIN, /^\//, "must be an absolute path, not a PATH lookup");
  assert.deepEqual(create.layers, ["acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/3"]);
});

test("nodejsLayerArn is region-scoped", () => {
  // A layer ARN names its region; the function's region is the apps region, so
  // borrowing another region's ARN makes CreateFunction fail on a valid config.
  assert.equal(nodejsLayerArn("cn-hangzhou"), "acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3");
});

test("ensureFunction re-sends the layer and start command on the update path", async () => {
  // Functions created before the layer existed boot with a command that cannot
  // resolve. A code-only update would leave them broken through every redeploy
  // the user tries — the update has to repair the config, not just the code.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const upd = calls.find((c) => c[0] === "updateFunction")[2].body;
  assert.deepEqual(upd.customRuntimeConfig.command, [NODE_BIN]);
  assert.deepEqual(upd.customRuntimeConfig.args, ["server/index.mjs"]);
  assert.deepEqual(upd.layers, ["acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/3"]);
});

test("ensureFunction re-sends environmentVariables on the update path", async () => {
  // A redeploy rotates the app's DB password, so the env must be rewritten
  // alongside the code rather than assumed to survive.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureFunction("tc-app-1", {
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
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const create = calls.find((c) => c[0] === "createFunction")[1].body;
  assert.equal(create.vpcConfig.vpcId, "vpc-apps");
  assert.deepEqual(create.vpcConfig.vSwitchIds, ["vsw-apps"]);
  assert.equal(create.vpcConfig.securityGroupId, "sg-apps");
  assert.equal(create.internetAccess, true);

  const { client: existing, calls: updateCalls } = fakeClient();
  const ops2 = makeFcOps(existing as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen", vpc });
  await ops2.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
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

test("ensureHttpTrigger returns the public invoke URL", async () => {
  const { client } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.equal(url, "https://fn.example.fcapp.run");
});

test("ensureHttpTrigger allows the methods a browser actually sends", async () => {
  // The trigger refuses anything outside this list with a 403 the app never
  // sees. Leaving OPTIONS out fails every CORS preflight; leaving HEAD out
  // breaks link previews and health checks.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
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
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  await ops.ensureHttpTrigger("tc-app-1");
  const upd = calls.find((c) => c[0] === "updateTrigger");
  assert.ok(upd, "an existing trigger must be updated, not silently left alone");
  assert.ok(JSON.parse(upd[3].body.triggerConfig).methods.includes("OPTIONS"));
});

test("ensureHttpTrigger swallows 'trigger already exists' then reads the URL", async () => {
  const conflict = Object.assign(new Error("exists"), { statusCode: 409, code: "TriggerAlreadyExists" });
  const { client } = fakeClient({ createTrigger: async () => { throw conflict; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc", region: "cn-shenzhen" });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.equal(url, "https://fn.example.fcapp.run");
});
