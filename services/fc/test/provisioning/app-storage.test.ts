/**
 * The session policy is the entire tenancy boundary for app files, and it has
 * no runtime signal when it is wrong: a policy that grants too much simply
 * works, on every app, until someone reads another app's objects. So it is
 * asserted verbatim here rather than "does it contain the app id" - a check
 * that would pass for a policy granting the whole bucket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeAppFilePath,
  appFileKey,
  appFilePathFromKey,
  appFilesPrefix,
  appStorageBucket,
  defaultStorageQuotaBytes,
  type AppsOssProfile,
} from "../../src/lib/provisioning/apps-oss.js";
import {
  assumeAppStorageRole,
  buildAppStoragePolicy,
  isOverQuota,
  measurePrefixUsage,
  signRpcV1,
  storageSessionName,
  AppStorageUnavailable,
} from "../../src/lib/provisioning/app-storage.js";

const APP = "0c0a97bf-d615-47f1-b471-45cb717f1629";
const PROFILE: AppsOssProfile = {
  bucket: "teamclu-app",
  region: "cn-shenzhen",
  endpoint: "https://oss-cn-shenzhen.aliyuncs.com",
  accessKeyId: "LTAI-test",
  accessKeySecret: "secret",
  forcePathStyle: false,
};

test("session policy is exactly the two statements the app needs", () => {
  const policy = JSON.parse(buildAppStoragePolicy("teamclu-app", APP));
  assert.deepEqual(policy, {
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "oss:GetObject",
          "oss:PutObject",
          "oss:DeleteObject",
          "oss:AbortMultipartUpload",
          "oss:ListParts",
          "oss:GetObjectMeta",
        ],
        Resource: [`acs:oss:*:*:teamclu-app/app-files/${APP}/*`],
      },
      {
        Effect: "Allow",
        Action: ["oss:ListObjects"],
        Resource: ["acs:oss:*:*:teamclu-app"],
        Condition: { StringLike: { "oss:Prefix": [`app-files/${APP}/*`] } },
      },
    ],
  });
});

test("list permission is conditioned on the prefix, not granted bucket-wide", () => {
  // The trap this guards: ListObjects authorizes against the BUCKET, so a
  // Resource-only grant lets any app enumerate every other app's keys.
  const policy = JSON.parse(buildAppStoragePolicy("b", APP));
  const listStatement = policy.Statement.find((s: any) => s.Action.includes("oss:ListObjects"));
  assert.ok(listStatement.Condition, "ListObjects must carry a prefix condition");
  assert.deepEqual(listStatement.Condition.StringLike["oss:Prefix"], [`app-files/${APP}/*`]);
});

test("policy for one app never matches another app's prefix", () => {
  const other = "11111111-2222-3333-4444-555555555555";
  const policy = buildAppStoragePolicy("teamclu-app", APP);
  assert.ok(!policy.includes(other));
  assert.ok(policy.includes(`app-files/${APP}/`));
});

test("session name identifies the app for ActionTrail and fits STS limits", () => {
  const name = storageSessionName(APP);
  assert.equal(name, `tc-app-${APP}`);
  assert.ok(name.length <= 64);
  assert.match(name, /^[A-Za-z0-9.@_-]+$/);
});

test("file paths that could escape the prefix are rejected", () => {
  const NUL = String.fromCharCode(0);
  const BEL = String.fromCharCode(7);
  const bad = [
    "/etc/passwd",
    "../other-app/secret",
    "a/../../b",
    "a//b",
    "trailing/",
    "",
    `with${NUL}null`,
    `bell${BEL}`,
  ];
  for (const p of bad) {
    assert.throws(() => assertSafeAppFilePath(p), undefined, `expected reject: ${JSON.stringify(p)}`);
  }
});

test("ordinary paths, including nested and non-ASCII ones, are accepted", () => {
  for (const good of ["a.txt", "reports/2026/q3.csv", "cover.png", "a.b.c", "..hidden"]) {
    assert.equal(assertSafeAppFilePath(good), good);
  }
});

test("key length is checked after prefixing, not before", () => {
  // 1000 bytes passes on its own but not once the ~50-byte prefix is added.
  const path = "x".repeat(1000);
  assert.equal(assertSafeAppFilePath(path), path);
  assert.throws(() => appFileKey(APP, path), /1024-byte/);
});

test("key round-trips through the prefix", () => {
  const key = appFileKey(APP, "reports/q3.csv");
  assert.equal(key, `app-files/${APP}/reports/q3.csv`);
  assert.equal(appFilePathFromKey(APP, key), "reports/q3.csv");
  assert.equal(appFilePathFromKey("other", key), null);
});

test("app files never share the code artifact's prefix", () => {
  // The separation the delete path depends on: dropping `apps/<id>/` must not
  // be able to take the user's files with it.
  assert.ok(appFilesPrefix(APP).startsWith("app-files/"));
  assert.ok(!appFilesPrefix(APP).startsWith("apps/"));
});

test("bucket comes from the row when set, else from the profile", () => {
  assert.equal(appStorageBucket(null, PROFILE), "teamclu-app");
  assert.equal(appStorageBucket({ oss_bucket: null }, PROFILE), "teamclu-app");
  assert.equal(appStorageBucket({ oss_bucket: "  " }, PROFILE), "teamclu-app");
  assert.equal(appStorageBucket({ oss_bucket: "dedicated" }, PROFILE), "dedicated");
});

test("quota falls back to the deployment default and tolerates junk", () => {
  assert.equal(defaultStorageQuotaBytes({} as NodeJS.ProcessEnv), null);
  assert.equal(defaultStorageQuotaBytes({ APPS_STORAGE_QUOTA_BYTES: "0" } as NodeJS.ProcessEnv), null);
  assert.equal(defaultStorageQuotaBytes({ APPS_STORAGE_QUOTA_BYTES: "abc" } as NodeJS.ProcessEnv), null);
  assert.equal(defaultStorageQuotaBytes({ APPS_STORAGE_QUOTA_BYTES: "1048576" } as NodeJS.ProcessEnv), 1048576);
});

test("over-quota is false while anything is unknown", () => {
  assert.equal(isOverQuota(null, 100), false, "never measured is not over");
  assert.equal(isOverQuota(500, null), false, "no quota is not over");
  assert.equal(isOverQuota(500, 0), false, "zero quota means unlimited, not blocked");
  assert.equal(isOverQuota(99, 100), false);
  assert.equal(isOverQuota(100, 100), true);
});

test("RPC v1 signing sorts, encodes and signs the canonical string", () => {
  const body = signRpcV1({ B: "2", A: "1 space", "C*": "~tilde" }, "sk");
  assert.match(body, /^A=1%20space&B=2&C%2A=~tilde&Signature=/);
});

test("AssumeRole sends the scoped policy and returns the credentials", async () => {
  let sent = "";
  const creds = await assumeAppStorageRole(
    PROFILE,
    { appId: APP, bucket: "teamclu-app", roleArn: "acs:ram::1:role/r", durationSeconds: 1800 },
    {
      nonce: () => "nonce",
      now: () => new Date("2026-09-09T00:00:00.000Z"),
      fetchImpl: (async (_url: string, init: any) => {
        sent = init.body;
        return new Response(
          JSON.stringify({
            Credentials: {
              AccessKeyId: "STS.ak",
              AccessKeySecret: "STS.sk",
              SecurityToken: "token",
              Expiration: "2026-09-09T01:00:00Z",
            },
          }),
          { status: 200 },
        );
      }) as any,
    },
  );
  assert.equal(creds.accessKeyId, "STS.ak");
  assert.equal(creds.securityToken, "token");
  assert.equal(creds.bucket, "teamclu-app");
  assert.equal(creds.prefix, `app-files/${APP}/`);
  assert.match(sent, /DurationSeconds=1800/);
  assert.match(sent, /Action=AssumeRole/);
  // The policy travels URL-encoded; decode that one parameter rather than
  // trusting a substring match against the whole body.
  const policy = decodeURIComponent(/(?:^|&)Policy=([^&]*)/.exec(sent)![1]);
  assert.deepEqual(JSON.parse(policy), JSON.parse(buildAppStoragePolicy("teamclu-app", APP)));
});

test("an STS refusal surfaces its own message instead of a generic failure", async () => {
  await assert.rejects(
    assumeAppStorageRole(
      PROFILE,
      { appId: APP, bucket: "b", roleArn: "acs:ram::1:role/r" },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ Code: "NoPermission", Message: "not authorized to sts:AssumeRole" }),
            { status: 403 },
          )) as any,
      },
    ),
    (e: unknown) =>
      e instanceof AppStorageUnavailable &&
      /NoPermission/.test((e as Error).message) &&
      /sts:AssumeRole/.test((e as Error).message),
  );
});

test("usage sweep pages and reports truncation instead of a short count", async () => {
  let call = 0;
  const s3: any = {
    send: async () => {
      call += 1;
      return call < 3
        ? { Contents: [{ Size: 10 }, { Size: 5 }], IsTruncated: true, NextContinuationToken: `c${call}` }
        : { Contents: [{ Size: 1 }], IsTruncated: false };
    },
  };
  assert.deepEqual(await measurePrefixUsage(s3, "b", "p/"), { bytes: 31, objects: 5, truncated: false });

  const endless: any = {
    send: async () => ({ Contents: [{ Size: 1 }], IsTruncated: true, NextContinuationToken: "x" }),
  };
  const capped = await measurePrefixUsage(endless, "b", "p/", 3);
  assert.equal(capped.truncated, true, "a capped sweep must not look like a small app");
  assert.equal(capped.objects, 3);
});
