import { describe, expect, it } from "vitest";
import { legacyAppDomainChoice } from "../app-deploy-confirm";

const legacy = {
  usesAppCodeDomain: false,
  fcStatus: "live",
  fcEndpoint: "https://origin.example",
  publicUrl: "https://shop.apps.example",
  appCodeUrl: "https://a-k7m2q9vx4n8p.apps.example",
};

describe("deployment domain checkbox eligibility", () => {
  it("offers migration for an existing app currently deployed on its old domain", () => {
    expect(legacyAppDomainChoice(legacy)).toEqual({
      currentUrl: "https://shop.apps.example",
      codeUrl: "https://a-k7m2q9vx4n8p.apps.example",
    });
  });

  it.each([
    { usesAppCodeDomain: true },
    { usesAppCodeDomain: undefined },
    { fcStatus: null },
    { fcStatus: "not_deployed" },
    { fcStatus: "awaiting_build" },
    { fcStatus: "deploying" },
    { fcStatus: "deploy_error" },
    { fcEndpoint: null },
    { fcEndpoint: "" },
    { publicUrl: null },
    { publicUrl: "" },
    { appCodeUrl: undefined },
    { appCodeUrl: null },
    { appCodeUrl: "" },
    { publicUrl: legacy.appCodeUrl },
  ])("hides the checkbox when there is no live legacy domain: %j", (patch) => {
    expect(legacyAppDomainChoice({ ...legacy, ...patch })).toBeNull();
  });
});
