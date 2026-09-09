import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appImageReference,
  appImageRepository,
  appImageTag,
  imageBelongsToApp,
  imageForPull,
  resolveAppsRegistry,
} from "../../src/lib/provisioning/apps-registry.js";

const creds = {
  APPS_REGISTRY_USERNAME: "teamclu-push",
  APPS_REGISTRY_PASSWORD: "push-secret",
};

test("a deployment with no registry names the variable to set", () => {
  const out = resolveAppsRegistry({});
  assert.match(out.error ?? "", /APPS_REGISTRY_HOST/);
  assert.equal(out.config, undefined);

  // A host with no login is a half-configured deployment, which fails at the
  // push rather than at the deploy unless it is caught here.
  const half = resolveAppsRegistry({ APPS_REGISTRY_HOST: "registry.example.com" });
  assert.match(half.error ?? "", /APPS_REGISTRY_USERNAME/);
});

test("the namespace defaults, and pulling happens where pushing does", () => {
  const { config } = resolveAppsRegistry({
    APPS_REGISTRY_HOST: "registry.example.com",
    ...creds,
  });
  assert.equal(config?.namespace, "apps");
  assert.equal(config?.pullHost, "registry.example.com");
});

test("without a read-only login the function carries the push credential", () => {
  // Recorded rather than prevented: a deployment that has not set up a second
  // account still deploys, and the fallback is what the comment on the config
  // warns about.
  const { config } = resolveAppsRegistry({
    APPS_REGISTRY_HOST: "registry.example.com",
    ...creds,
  });
  assert.deepEqual(config?.pull, config?.push);

  const split = resolveAppsRegistry({
    APPS_REGISTRY_HOST: "registry.example.com",
    ...creds,
    APPS_REGISTRY_PULL_USERNAME: "teamclu-pull",
    APPS_REGISTRY_PULL_PASSWORD: "pull-secret",
  });
  assert.deepEqual(split.config?.pull, { username: "teamclu-pull", password: "pull-secret" });
  assert.equal(split.config?.push.username, "teamclu-push");
});

test("an app's repository is named for its function", () => {
  assert.equal(appImageRepository("3f1c9a2e-abc"), "tc-app-3f1c9a2e-abc");
  const { config } = resolveAppsRegistry({
    APPS_REGISTRY_HOST: "registry.example.com",
    APPS_REGISTRY_NAMESPACE: "teamclu",
    ...creds,
  });
  assert.equal(
    appImageReference(config!, "app-1", "abc1234"),
    "registry.example.com/teamclu/tc-app-app-1:abc1234",
  );
});

test("the tag is the commit when there is one", () => {
  // So an image traces back to the code in it, and a redeploy of an unchanged
  // commit reuses the layer instead of pushing a second copy.
  assert.equal(appImageTag("ABC1234"), "abc1234");
  assert.equal(
    appImageTag("0123456789abcdef0123456789abcdef01234567"),
    "0123456789abcdef0123456789abcdef01234567",
  );
});

test("an imported app deploying its working directory still gets a unique tag", () => {
  // No commit of ours exists for it, and overwriting one tag forever would make
  // a rollback impossible and a redeploy ambiguous.
  const at = new Date("2026-09-09T12:00:00Z");
  assert.equal(appImageTag(null, at), `d${Math.floor(at.getTime() / 1000)}`);
  assert.equal(appImageTag("not-a-sha", at), `d${Math.floor(at.getTime() / 1000)}`);
});

test("the pull host replaces the push host, and nothing else", () => {
  assert.equal(
    imageForPull("registry.example.com/apps/tc-app-1:sha", "registry.internal:5000"),
    "registry.internal:5000/apps/tc-app-1:sha",
  );
  // Unset, identical, or a reference that names no registry at all: untouched.
  assert.equal(imageForPull("registry.example.com/apps/x:1", undefined), "registry.example.com/apps/x:1");
  assert.equal(imageForPull("registry.example.com/apps/x:1", "registry.example.com"), "registry.example.com/apps/x:1");
  assert.equal(imageForPull("library/nginx:latest", "registry.internal"), "library/nginx:latest");
});

test("an image is this app's only when it names this app's repository", () => {
  const { config } = resolveAppsRegistry({
    APPS_REGISTRY_HOST: "registry.example.com",
    APPS_REGISTRY_PULL_HOST: "registry.internal:5000",
    ...creds,
  });
  const cfg = config!;
  const own = (image: string) => imageBelongsToApp(cfg, "app-1", image);

  // Any tag, because the build corrects the tag the control plane minted.
  assert.equal(own("registry.example.com/apps/tc-app-app-1:abc1234"), true);
  assert.equal(own("registry.example.com/apps/tc-app-app-1:whatever"), true);
  // A digest names the same repository, and is already immutable.
  assert.equal(own("registry.example.com/apps/tc-app-app-1@sha256:deadbeef"), true);
  // The daemon reports the push host; a client that normalised to the pull host
  // has still named the same image.
  assert.equal(own("registry.internal:5000/apps/tc-app-app-1:abc1234"), true);

  // Another app's image is the whole point of the check.
  assert.equal(own("registry.example.com/apps/tc-app-app-2:abc1234"), false);
  // A repository that merely starts the same way is not the same repository.
  assert.equal(own("registry.example.com/apps/tc-app-app-1-evil:abc1234"), false);
  // Nor is another namespace, or another registry entirely.
  assert.equal(own("registry.example.com/other/tc-app-app-1:abc1234"), false);
  assert.equal(own("evil.example.com/apps/tc-app-app-1:abc1234"), false);
  // A bare tag with no repository at all cannot be it either.
  assert.equal(own("tc-app-app-1:abc1234"), false);
});
