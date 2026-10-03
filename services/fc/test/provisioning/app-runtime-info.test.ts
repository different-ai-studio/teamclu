import { test } from "node:test";
import assert from "node:assert/strict";
import { Function as FcFunction, FunctionLayer, CustomRuntimeConfig, GetFunctionResponse } from "@alicloud/fc20230330";
import { projectFunction, driftFields } from "../../src/lib/provisioning/app-runtime-info.js";
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
