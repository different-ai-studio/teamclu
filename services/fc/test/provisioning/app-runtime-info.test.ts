import { installOriginEnv } from "../fixtures/apps-origin-auth/config.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Function as FcFunction, FunctionLayer, CustomRuntimeConfig, GetFunctionResponse } from "@alicloud/fc20230330";
import { projectFunction, driftFields, readAppOriginSecurity, projectOriginSecurity } from "../../src/lib/provisioning/app-runtime-info.js";
import { preflightAppDeploy } from "../../src/lib/provisioning/app-deploy-preflight.js";

const region = "cn-shenzhen";
const arn = "acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/3";
const start = {
  fcRuntime: "custom.debian10",
  command: ["/opt/nodejs20/bin/node"],
  args: ["server/index.mjs"],
  port: 9000,
  layers: ["Nodejs20:3"],
};

function providerResponse(layerArn = arn) {
  return new GetFunctionResponse({
    body: new FcFunction({
      runtime: start.fcRuntime,
      customRuntimeConfig: new CustomRuntimeConfig({ command: start.command, args: start.args, port: start.port }),
      layers: [new FunctionLayer({ arn: layerArn, size: 51185757 })],
    }),
  });
}

test("FC SDK layer objects allow an unchanged deployment through preflight", () => {
  const raw = providerResponse();
  for (const response of [raw, raw.body]) {
    const provider = projectFunction(response);
    assert.deepEqual(provider.layers, [arn]);
    const fields = driftFields(start, provider, region, "node");
    assert.deepEqual(fields, []);
    const result = preflightAppDeploy("app-1", "a".repeat(40),
      { build: { kind: "node", output: ".output" }, start },
      { runtime: "node", startSpec: start, provider, drift: fields.length > 0, driftFields: fields },
      { region, capabilities: [], catalogComplete: false });
    assert.deepEqual(result.preview.changes, []);
  }
});

test("a changed FC SDK layer ARN still blocks redeployment as provider drift", () => {
  const changedArn = arn.replace("/3", "/4");
  const provider = projectFunction(providerResponse(changedArn));
  assert.deepEqual(provider.layers, [changedArn]);
  const fields = driftFields(start, provider, region, "node");
  assert.deepEqual(fields, ["layers"]);
  assert.throws(() => preflightAppDeploy("app-1", "a".repeat(40),
    { build: { kind: "node", output: ".output" }, start },
    { runtime: "node", startSpec: start, provider, drift: true, driftFields: fields },
    { region, capabilities: [] }), (error: any) => error.code === "live_state_drift");
});

test("layer projection preserves provider order and accepts existing ARN strings", () => {
  const secondArn = "acs:fc:cn-shenzhen:123456:layers/private/versions/1";
  assert.deepEqual(projectFunction({ layers: [{ arn, size: 42 }, secondArn] }).layers, [arn, secondArn]);
});

test("absent or unusable provider layers remain empty and detect missing pinned layers", () => {
  for (const layers of [undefined, [], [null, {}, { arn: 42 }]]) {
    const provider = projectFunction({ ...providerResponse().body, layers });
    assert.deepEqual(provider.layers, []);
    assert.deepEqual(driftFields(start, provider, region, "node"), ["layers"]);
  }
});


const originRow = { id: "76af539e-5341-4e96-bda7-6c8dacf2b092", slug: "app-a", fc_function_name: "legacy-name", fc_region: "cn-shenzhen" };
const protectedSummary = { status: "protected" as const, internetUrlDisabled: true, customDomainAuth: "jwt" as const, httpsOnly: true, driftFields: [] };

test("origin status correlates the raw slug and full UUID with the canonical Host", async () => {
  const restore = installOriginEnv();
  try {
    const seen: unknown[] = [];
    const result = await readAppOriginSecurity({ ...originRow, fc_endpoint: "https://app-a-76af539e.origins.test" },
      async (name, host, target, _config, actualRegion) => { seen.push(name, host, target, actualRegion); return protectedSummary; });
    assert.deepEqual(result, protectedSummary);
    assert.deepEqual(seen, ["legacy-name", "app-a-76af539e.origins.test", { appId: originRow.id, slug: originRow.slug }, "cn-shenzhen"]);
  } finally { restore(); }
});

test("legacy status remains unverified and retains readonly unexpected-entry evidence", async () => {
  const restore = installOriginEnv();
  try {
    for (const endpoint of ["http://app-a-76af539e.origins.test", "https://old.fcapp.run"]) {
      const result = await readAppOriginSecurity({ ...originRow, fc_endpoint: endpoint }, async () => ({ ...protectedSummary, status: "drift", driftFields: ["extraHttpTriggers"] }));
      assert.equal(result.status, "legacy_unverified");
      assert.deepEqual(result.driftFields, ["extraHttpTriggers"]);
    }
    delete process.env.APPS_FC_ROUTE_DOMAIN;
    const result = await readAppOriginSecurity({ ...originRow, fc_endpoint: "https://old.fcapp.run" }, async () => { throw new Error("must not read"); });
    assert.equal(result.status, "legacy_unverified");
  } finally { restore(); }
});

test("origin status fails safely without provider/configuration or for an incorrect managed Host", async () => {
  const restore = installOriginEnv();
  try {
    for (const endpoint of ["https://app-a-76af539e.origins.test", "https://other-76af539e.origins.test"]) {
      const result = await readAppOriginSecurity({ ...originRow, fc_endpoint: endpoint }, async () => { throw new Error("SECRET JWT JWKS PEM"); });
      assert.equal(result.status, "unavailable");
      assert.equal(JSON.stringify(result).includes("SECRET"), false);
    }
    delete process.env.APPS_FC_ORIGIN_KEYRING;
    assert.equal((await readAppOriginSecurity({ ...originRow, fc_endpoint: "https://app-a-76af539e.origins.test" })).status, "unavailable");
  } finally { restore(); }
});

test("origin security projection rejects arbitrary fields, enum strings and secret drift values", () => {
  assert.deepEqual(projectOriginSecurity({ status: "SECRET", internetUrlDisabled: "SECRET", customDomainAuth: "SECRET", httpsOnly: "SECRET", driftFields: ["SECRET", "authConfig.JWKS", "authConfig.JWKS", { secret: "SECRET" }], privateKey: "SECRET", authConfig: "SECRET" }),
    { status: "unavailable", internetUrlDisabled: null, customDomainAuth: "unknown", httpsOnly: null, driftFields: ["authConfig.JWKS"] });
});
