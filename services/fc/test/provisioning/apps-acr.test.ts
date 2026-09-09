import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appImageReference,
  appImageRepository,
  appImageTag,
  resolveAppsAcr,
} from "../../src/lib/provisioning/apps-acr.js";

const profile = {
  bucket: "teamclu-app",
  region: "cn-shenzhen",
  endpoint: "https://oss-cn-shenzhen.aliyuncs.com",
  accessKeyId: "ak",
  accessKeySecret: "sk",
  forcePathStyle: false,
};

test("a deployment with no namespace names the variable to set", () => {
  const out = resolveAppsAcr(profile, {});
  assert.match(out.error ?? "", /APPS_ACR_NAMESPACE/);
  assert.equal(out.config, undefined);
});

test("the registry defaults to the apps region, and pulls where it pushes", () => {
  // Defaulting the pull host to the VPC endpoint would work only for functions
  // attached to a VPC that can reach it — and would fail at instance start,
  // long after the deploy said it succeeded.
  const { config } = resolveAppsAcr(profile, { APPS_ACR_NAMESPACE: "teamclu" });
  assert.equal(config?.pushRegistry, "registry.cn-shenzhen.aliyuncs.com");
  assert.equal(config?.pullRegistry, "registry.cn-shenzhen.aliyuncs.com");
  assert.equal(config?.accessKeyId, "ak", "the registry is in the apps account");
});

test("a VPC pull host is used only when it is set", () => {
  const { config } = resolveAppsAcr(profile, {
    APPS_ACR_NAMESPACE: "teamclu",
    APPS_ACR_PULL_REGISTRY: "registry-vpc.cn-shenzhen.aliyuncs.com",
  });
  assert.equal(config?.pushRegistry, "registry.cn-shenzhen.aliyuncs.com");
  assert.equal(config?.pullRegistry, "registry-vpc.cn-shenzhen.aliyuncs.com");
});

test("an app's repository is named for its function", () => {
  assert.equal(appImageRepository("3f1c9a2e-abc"), "tc-app-3f1c9a2e-abc");
  const { config } = resolveAppsAcr(profile, { APPS_ACR_NAMESPACE: "teamclu" });
  assert.equal(
    appImageReference(config!, "app-1", "abc1234"),
    "registry.cn-shenzhen.aliyuncs.com/teamclu/tc-app-app-1:abc1234",
  );
});

test("the tag is the commit when there is one", () => {
  // So an image traces back to the code in it, and a redeploy of an unchanged
  // commit reuses the layer instead of pushing a second copy.
  assert.equal(appImageTag("ABC1234"), "abc1234");
  assert.equal(appImageTag("0123456789abcdef0123456789abcdef01234567"), "0123456789abcdef0123456789abcdef01234567");
});

test("an imported app deploying its working directory still gets a unique tag", () => {
  // No commit of ours exists for it, and overwriting one tag forever would make
  // a rollback impossible and a redeploy ambiguous.
  const at = new Date("2026-09-09T12:00:00Z");
  assert.equal(appImageTag(null, at), `d${Math.floor(at.getTime() / 1000)}`);
  assert.equal(appImageTag("not-a-sha", at), `d${Math.floor(at.getTime() / 1000)}`);
});
