/**
 * The Gitea forge's deploy guard and external-repo credentials, on their own.
 * The repository's use of them is covered end to end in supabase-repo.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGiteaForge } from "../../src/lib/forge/index.js";
import { appsSupabase, fakeGitea } from "../fixtures/apps-repository.js";

const HEAD = "a".repeat(40);
const APP = { id: "app-1", git_auth_kind: "gitea_deploy_key", git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-1.git" };

function forge(over: Record<string, unknown> = {}) {
  const gitea = fakeGitea({ getRepoHead: async () => ({ sha: HEAD, branch: "main" }), ...over });
  const db = appsSupabase();
  return makeGiteaForge({ gitea })({ serviceRoleClient: async () => db });
}

test("the deploy guard passes the commit at the branch head, at every stage", async () => {
  const f = forge();
  for (const stage of ["preflight", "deploy", "finalize"] as const) {
    await f.deployGuard(APP, stage, { revision: HEAD, gitCommitSha: HEAD });
  }
});

test("the deploy guard refuses anything but the head, with the message for its stage", async () => {
  const f = forge();
  const other = "b".repeat(40);
  const cases: Array<[stage: "preflight" | "deploy" | "finalize", deploy: { revision: string; gitCommitSha?: string }, message: RegExp]> = [
    ["preflight", { revision: other, gitCommitSha: other }, /clean checkout at exact remote HEAD/],
    ["preflight", { revision: HEAD, gitCommitSha: undefined }, /clean checkout at exact remote HEAD/],
    ["deploy", { revision: other, gitCommitSha: other }, /HEAD changed after preflight/],
    ["finalize", { revision: HEAD, gitCommitSha: other }, /built SHA differs from preflight revision/],
  ];
  for (const [stage, deploy, message] of cases) {
    await assert.rejects(
      () => f.deployGuard(APP, stage, deploy),
      (e: any) => e.statusCode === 409 && e.code === "revision_mismatch" && message.test(e.message),
      `${stage} ${JSON.stringify(deploy)}`,
    );
  }
});

test("finalize trusts preflight for the head and asks the forge nothing", async () => {
  let asked = 0;
  const f = forge({ getRepoHead: async () => { asked++; return { sha: HEAD, branch: "main" }; } });
  await f.deployGuard(APP, "finalize", { revision: HEAD, gitCommitSha: HEAD });
  assert.equal(asked, 0);
});

test("an external credential applies only to an app imported over http(s)", async () => {
  const f = forge();
  await assert.rejects(
    () => f.storeExternalCredential({ id: "app-1", git_remote_url: "git@github.com:o/r.git" }, { username: "me", token: "t" }),
    (e: any) => e.statusCode === 400 && e.code === "validation_failed",
  );
  const prev = process.env.APP_SECRETS_ENCRYPTION_KEY;
  process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const app = { id: "app-1", git_remote_url: "https://github.com/o/r.git", git_auth_kind: "https_token" };
    assert.deepEqual(await f.storeExternalCredential(app, { username: "me", token: "t" }), { authKind: "https_token" });
    // The same callers that get a deploy key for a hosted repo get the stored token back.
    const cred = await f.issueCredential(app, "actor-1", { readOnly: true });
    assert.deepEqual(cred, { remoteUrl: app.git_remote_url, authKind: "https_token", username: "me", token: "t" });
  } finally {
    if (prev === undefined) delete process.env.APP_SECRETS_ENCRYPTION_KEY;
    else process.env.APP_SECRETS_ENCRYPTION_KEY = prev;
  }
});
