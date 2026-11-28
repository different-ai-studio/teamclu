import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("acceptance script refuses a repo outside the recorded dedicated fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamclu-git-fixture-"));
  try {
    const fixture = join(dir, "fixture.json");
    writeFileSync(fixture, JSON.stringify({
      purpose: "hangzhou-git-account-auth-acceptance",
      orgId: "aaaaaaaa-0000-4000-8000-000000000001",
      appId: "bbbbbbbb-0000-4000-8000-000000000002",
      repoUrl: "https://gitea.teamclu.cn/oaaaaaaaa000040008000000000000001/tc-app-bbbbbbbb-0000-4000-8000-000000000002.git",
      accounts: {
        admin: "uaaaaaaaa000040008000000000000001",
        write: "uaaaaaaaa000040008000000000000002",
        read: "uaaaaaaaa000040008000000000000003",
        outsider: "uaaaaaaaa000040008000000000000004",
      },
    }));
    const out = spawnSync("bash", ["scripts/accept-prod-git-account-auth.sh"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        TEAMCLU_GIT_FIXTURE_RECORD: fixture,
        TEAMCLU_GIT_TEST_REPO_URL: "https://gitea.teamclu.cn/occcccccc000040008000000000000003/tc-app-dddddddd-0000-4000-8000-000000000004.git",
        TEAMCLU_GIT_ADMIN_TOKEN: "dummy",
        TEAMCLU_GIT_WRITE_TOKEN: "dummy",
        TEAMCLU_GIT_READ_TOKEN: "dummy",
        TEAMCLU_GIT_OUTSIDER_TOKEN: "dummy",
      },
    });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /fixture/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
