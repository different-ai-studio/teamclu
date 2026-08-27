import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicDeployConfirm } from "@/lib/app-deploy-confirm";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
  updateAppProvisionStatus: vi.fn(),
  updateAppDeployStatus: vi.fn(),
  deployApp: vi.fn(),
  finalizeDeploy: vi.fn(),
  getGitCredential: vi.fn(),
  getGitHead: vi.fn(),
  seedDaemonApp: vi.fn(),
  buildDaemonApp: vi.fn(),
  bindAppWorkdir: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    apps: {
      listApps: mocks.listApps,
      createApp: mocks.createApp,
      updateAppProvisionStatus: mocks.updateAppProvisionStatus,
      updateAppDeployStatus: mocks.updateAppDeployStatus,
      deployApp: mocks.deployApp,
      finalizeDeploy: mocks.finalizeDeploy,
      getGitCredential: mocks.getGitCredential,
      getGitHead: mocks.getGitHead,
    },
  }),
}));

vi.mock("@/lib/daemon-local-client", () => ({
  seedDaemonApp: mocks.seedDaemonApp,
  buildDaemonApp: mocks.buildDaemonApp,
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

vi.mock("@/lib/app-session", () => ({ bindAppWorkdir: mocks.bindAppWorkdir }));

vi.mock("@/lib/app-deploy-confirm", () => ({
  publicDeployConfirm: { run: vi.fn(() => true) },
}));

/** What the daemon client returns: an outcome plus where it wrote. */
const seedResult = (
  outcome: "seeded" | "failed" | "unreachable",
  over: { workdir?: string | null; error?: string | null } = {},
) => ({ outcome, workdir: null, error: null, ...over });

const buildResult = (
  outcome: "built" | "failed" | "unreachable",
  error: string | null = null,
) => ({ outcome, error });

const gitCred = {
  remoteUrl: "git@gitea:team/app-1.git",
  authKind: "deploy_key" as const,
  privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
  deployKeyId: 1,
  expiresAt: "2026-06-14T01:00:00.000Z",
};

const appRow = (over = {}) => ({
  id: "app-1",
  teamId: "team-1",
  name: "App",
  slug: "app",
  type: "fullstack_tanstack_postgres",
  visibility: "team",
  workspaceId: "ws-1",
  gitRemoteUrl: null,
  gitAuthKind: null,
  gitCommitSha: null,
  runtime: "node" as const,
  authMode: "none" as const,
  oauthClientId: null,
  provisionStatus: "pending",
  fcStatus: null,
  fcEndpoint: null,
  fcFunctionName: null,
  fcRegion: null,
  publicUrl: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  ...over,
});

describe("apps-store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.seedDaemonApp.mockResolvedValue(seedResult("unreachable"));
    mocks.getGitCredential.mockResolvedValue(gitCred);
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [],
      loaded: false,
      loading: false,
      error: null,
      teamId: null,
    });
  });

  it("loads apps for a team (cache-first: skips reload when loaded)", async () => {
    mocks.listApps.mockResolvedValueOnce([appRow({ name: "Alpha" })]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    expect(useAppsStore.getState().items[0]).toMatchObject({
      id: "app-1",
      name: "Alpha",
    });

    await useAppsStore.getState().load("team-1"); // cached → no second call
    expect(mocks.listApps).toHaveBeenCalledTimes(1);
  });

  it("force reload calls the backend again", async () => {
    mocks.listApps.mockResolvedValue([appRow()]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    await useAppsStore.getState().load("team-1", { force: true });
    expect(mocks.listApps).toHaveBeenCalledTimes(2);
  });

  it("create prepends the new app and returns it", async () => {
    mocks.createApp.mockResolvedValueOnce(appRow({ id: "app-2", name: "New" }));
    const { useAppsStore } = await import("./apps-store");
    const row = await useAppsStore.getState().create({
      teamId: "team-1",
      name: "New",
      type: "fullstack_tanstack_postgres",
      visibility: "personal",
    });
    expect(row.id).toBe("app-2");
    expect(useAppsStore.getState().items[0]).toMatchObject({ id: "app-2" });
  });

  it("kicks the daemon seed for a freshly created (pending) app", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-4", name: "Slides", type: "slides", provisionStatus: "pending" }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "Slides",
      type: "slides",
      visibility: "team",
    });
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-4", "team-1", "Slides", "slides", null, null);
  });

  it("create: seeded → PATCH ready", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "App", "fullstack_tanstack_postgres", null, null);
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: failed → PATCH error", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("failed"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["error"]);
  });

  it("create: unreachable → no status PATCH (stays pending)", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("unreachable"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.updateAppProvisionStatus).not.toHaveBeenCalled();
  });

  it("reseed: re-runs seed for an existing app (error → seeded → ready)", async () => {
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [appRow({ provisionStatus: "error", gitRemoteUrl: "https://g/x.git", teamId: "team-1" })],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
    });
    await useAppsStore.getState().reseed("app-1");
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "App", "fullstack_tanstack_postgres", "https://g/x.git", null);
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("reseed: a Gitea app that failed its seed push still gets a deploy key", async () => {
    // Reseed is offered on `pending` and `error`, never on `repo_created` —
    // keying the push path on that status sent every reseed down the clone-only
    // branch, which either refuses to clone over the template or clones the
    // empty Gitea repo and calls the empty app ready.
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [
        appRow({
          provisionStatus: "error",
          gitRemoteUrl: "git@gitea:team/app-1.git",
          gitAuthKind: "gitea_deploy_key",
          teamId: "team-1",
        }),
      ],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
    });
    await useAppsStore.getState().reseed("app-1");
    expect(mocks.getGitCredential).toHaveBeenCalledWith("app-1");
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      "App",
      "fullstack_tanstack_postgres",
      "git@gitea:team/app-1.git",
      gitCred.privateKeyPem,
    );
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: an imported app hands the daemon its repo URL", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", gitRemoteUrl: "git@github.com:owner/repo.git" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
      gitRemoteUrl: "git@github.com:owner/repo.git",
    });
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith(
      "app-1", "team-1", "App", "fullstack_tanstack_postgres", "git@github.com:owner/repo.git", null,
    );
  });

  it("create: repo_created fetches deploy key and seeds with push", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({
        provisionStatus: "repo_created",
        gitRemoteUrl: "git@gitea:team/app-1.git",
        gitAuthKind: "gitea_deploy_key",
      }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
    });
    expect(mocks.getGitCredential).toHaveBeenCalledWith("app-1");
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      "App",
      "fullstack_tanstack_postgres",
      "git@gitea:team/app-1.git",
      gitCred.privateKeyPem,
    );
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: the directory the daemon wrote to is recorded on the app's workspace", async () => {
    mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "pending" }));
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(
      seedResult("seeded", { workdir: "/home/.amuxd/teams/team-1/apps/app-1" }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
    });
    expect(mocks.bindAppWorkdir).toHaveBeenCalledWith(
      expect.objectContaining({ id: "app-1" }),
      "/home/.amuxd/teams/team-1/apps/app-1",
    );
  });

  it("create: a daemon that reports no workdir binds nothing (and still goes ready)", async () => {
    mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "pending" }));
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
    });
    expect(mocks.bindAppWorkdir).not.toHaveBeenCalled();
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: a failed clone tells the user what git said", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", gitRemoteUrl: "https://github.com/owner/nope.git" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(
      seedResult("failed", { error: "git clone failed: repository not found" }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
      gitRemoteUrl: "https://github.com/owner/nope.git",
    });
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["error"]);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "仓库克隆失败",
      { description: "git clone failed: repository not found" },
    );
  });

  it("create: a template app that fails to seed does not toast a clone error", async () => {
    mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "pending" }));
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("failed", { error: "disk full" }));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("create: a thrown status PATCH does not reject create", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockRejectedValue(new Error("boom"));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    const row = await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(row.id).toBe("app-1");
  });

  it("a thrown daemon seed error does NOT reject create (app is still returned)", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-6", provisionStatus: "pending" }),
    );
    mocks.seedDaemonApp.mockRejectedValueOnce(new Error("daemon exploded"));
    const { useAppsStore } = await import("./apps-store");
    const row = await useAppsStore.getState().create({
      teamId: "team-1",
      name: "Resilient",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(row.id).toBe("app-6");
    expect(useAppsStore.getState().items[0]).toMatchObject({ id: "app-6" });
  });
});

describe("apps-store deploy", () => {
  const readyApp = (over = {}) =>
    appRow({
      provisionStatus: "ready",
      teamId: "team-1",
      fcStatus: null,
      authMode: "platform",
      gitRemoteUrl: "git@gitea:team/app-1.git",
      gitAuthKind: "gitea_deploy_key",
      ...over,
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getGitHead.mockResolvedValue({ sha: "abc1234567890" });
    mocks.getGitCredential.mockResolvedValue(gitCred);
    vi.mocked(publicDeployConfirm.run).mockReturnValue(true);
    const mod = await import("./apps-store");
    mod.useAppsStore.setState({
      items: [readyApp()],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
      deployingIds: [],
    });
  });

  it("happy path: git-head → deploy → daemon build → finalize", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
      gitCommitSha: "abc1234567890",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(buildResult("built"));
    mocks.finalizeDeploy.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "live",
      fcEndpoint: "https://x.fcapp.run",
    });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.getGitHead).toHaveBeenCalledWith("app-1");
    expect(mocks.deployApp).toHaveBeenCalledWith("app-1", { gitCommitSha: "abc1234567890" });
    expect(mocks.getGitCredential).toHaveBeenCalledWith("app-1");
    expect(mocks.buildDaemonApp).toHaveBeenCalledWith("app-1", "team-1", {
      gitCommitSha: "abc1234567890",
      gitRemoteUrl: gitCred.remoteUrl,
      deployKeyPem: gitCred.privateKeyPem,
      presignedPut: "https://oss/put?sig=x",
    });
    expect(mocks.finalizeDeploy).toHaveBeenCalledWith("app-1", {
      gitCommitSha: "abc1234567890",
      deployToken: "tok-1",
    });
    expect(mocks.updateAppDeployStatus).not.toHaveBeenCalled();
    expect(useAppsStore.getState().items[0]).toMatchObject({
      fcStatus: "live",
      fcEndpoint: "https://x.fcapp.run",
    });
    expect(useAppsStore.getState().deployingIds).toEqual([]);
  });

  it("authMode=none prompts for public deploy confirmation", async () => {
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({ items: [readyApp({ authMode: "none" })] });
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp({ authMode: "none" }),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(buildResult("built"));
    mocks.finalizeDeploy.mockResolvedValueOnce({ ...readyApp({ authMode: "none" }), fcStatus: "live" });

    await useAppsStore.getState().deploy("app-1");
    expect(vi.mocked(publicDeployConfirm.run)).toHaveBeenCalled();
    expect(mocks.deployApp).toHaveBeenCalled();
  });

  it("authMode=none: declined confirm aborts deploy", async () => {
    vi.mocked(publicDeployConfirm.run).mockReturnValue(false);
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({ items: [readyApp({ authMode: "none" })] });

    await useAppsStore.getState().deploy("app-1");
    expect(mocks.getGitHead).not.toHaveBeenCalled();
    expect(mocks.deployApp).not.toHaveBeenCalled();
  });

  it("authMode=platform skips public confirm", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp({ authMode: "platform" }),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(buildResult("built"));
    mocks.finalizeDeploy.mockResolvedValueOnce({ ...readyApp({ authMode: "platform" }), fcStatus: "live" });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");
    expect(vi.mocked(publicDeployConfirm.run)).not.toHaveBeenCalled();
  });

  it("a daemon build that never finishes is reported as deploy_error", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(buildResult("unreachable"));
    mocks.updateAppDeployStatus.mockResolvedValueOnce({ ...readyApp(), fcStatus: "deploy_error" });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.finalizeDeploy).not.toHaveBeenCalled();
    expect(mocks.updateAppDeployStatus).toHaveBeenCalledWith(
      "app-1",
      "deploy_error",
      expect.stringContaining("amuxd"),
    );
    expect(useAppsStore.getState().items[0]).toMatchObject({ fcStatus: "deploy_error" });
  });

  it("maps dirty-tree daemon errors to Chinese copy", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(
      buildResult("failed", "uncommitted or unpushed changes; commit and push first"),
    );
    mocks.updateAppDeployStatus.mockResolvedValueOnce(null);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");
    expect(mocks.updateAppDeployStatus).toHaveBeenCalledWith(
      "app-1",
      "deploy_error",
      expect.stringContaining("未提交"),
    );
  });

  it("a thrown finalize is reported as deploy_error and clears the in-flight flag", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(buildResult("built"));
    mocks.finalizeDeploy.mockRejectedValueOnce(new Error("fc exploded"));
    mocks.updateAppDeployStatus.mockResolvedValueOnce(null);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.updateAppDeployStatus).toHaveBeenCalledWith("app-1", "deploy_error", "fc exploded");
    expect(useAppsStore.getState().deployingIds).toEqual([]);
  });

  it("an imported app deploys from the workdir, never through Gitea", async () => {
    // It has no tc-app-<id> repo, so git-head and git-credential both 404 —
    // routing every deploy through Gitea made these apps undeployable.
    const { useAppsStore } = await import("./apps-store");
    const imported = readyApp({
      gitRemoteUrl: "https://github.com/me/site.git",
      gitAuthKind: null,
      authMode: "platform",
    });
    useAppsStore.setState({ items: [imported] });
    mocks.deployApp.mockResolvedValueOnce({
      ...imported,
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
      gitCommitSha: null,
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(buildResult("built"));
    mocks.finalizeDeploy.mockResolvedValueOnce({ ...imported, fcStatus: "live" });

    await useAppsStore.getState().deploy("app-1");

    expect(mocks.getGitHead).not.toHaveBeenCalled();
    expect(mocks.getGitCredential).not.toHaveBeenCalled();
    expect(mocks.deployApp).toHaveBeenCalledWith("app-1", {});
    expect(mocks.buildDaemonApp).toHaveBeenCalledWith("app-1", "team-1", {
      gitCommitSha: undefined,
      gitRemoteUrl: undefined,
      deployKeyPem: undefined,
      presignedPut: "https://oss/put?sig=x",
    });
    expect(mocks.finalizeDeploy).toHaveBeenCalledWith("app-1", { deployToken: "tok-1" });
    expect(useAppsStore.getState().items[0]).toMatchObject({ fcStatus: "live" });
  });

  it("refuses to deploy an app that is not seeded yet", async () => {
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({ items: [appRow({ provisionStatus: "repo_created" })] });
    await useAppsStore.getState().deploy("app-1");
    expect(mocks.deployApp).not.toHaveBeenCalled();
  });
});

describe("mapDeployErrorReason", () => {
  it("maps known error families", async () => {
    const { mapDeployErrorReason } = await import("./apps-store");
    expect(mapDeployErrorReason("unsupported_auth_mode: third-party login is not supported for deploy yet"))
      .toContain("第三方登录");
    expect(mapDeployErrorReason("vanity_required: platform auth requires an apps public domain"))
      .toContain("公开域名");
    expect(mapDeployErrorReason("presigned upload URL expired; retry deploy"))
      .toContain("上传链接");
  });

  it("does not read the workdir path as a dead daemon", async () => {
    // Daemon errors quote `~/.amuxd/teams/<team>/apps/<app>`. Matching the bare
    // substring "amuxd" reported every one of them as "the daemon is not
    // running" and threw away the real cause.
    const { mapDeployErrorReason } = await import("./apps-store");
    const raw = "app workdir does not exist: /Users/me/.amuxd/teams/t1/apps/a1";
    expect(mapDeployErrorReason(raw)).toBe(raw);
    expect(mapDeployErrorReason("build output missing in .output/ under /Users/me/.amuxd/teams/t1"))
      .toContain(".output/");
  });

  it("still recognises a daemon that is actually unreachable", async () => {
    const { mapDeployErrorReason } = await import("./apps-store");
    expect(mapDeployErrorReason("amuxd daemon is not connected")).toContain("未连接");
    expect(mapDeployErrorReason("Cannot reach amuxd daemon at http://127.0.0.1:1234"))
      .toContain("未连接");
  });
});
