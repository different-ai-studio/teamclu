import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicDeployConfirm } from "@/lib/apps/app-deploy-confirm";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
  deleteApp: vi.fn(),
  updateAppProvisionStatus: vi.fn(),
  updateAppDeployStatus: vi.fn(),
  deployApp: vi.fn(),
  finalizeDeploy: vi.fn(),
  getGitCredential: vi.fn(),
  revokeGitCredential: vi.fn(),
  getGitHead: vi.fn(),
  setAppType: vi.fn(),
  seedDaemonApp: vi.fn(),
  cloneDaemonApp: vi.fn(),
  daemonAppWorkdir: vi.fn(),
  daemonLocalAppIds: vi.fn(),
  buildDaemonApp: vi.fn(),
  daemonAppManifest: vi.fn(),
  bindAppWorkdir: vi.fn(),
  bindDaemonAppWorkdir: vi.fn(),
  getDaemonEnvActivationDiagnostics: vi.fn(),
  toastError: vi.fn(),
  workdirExists: vi.fn(),
  readDir: vi.fn(),
  encodeWorkspaceId: (workspacePath: string) => {
    const bytes = new TextEncoder().encode(workspacePath);
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  },
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    apps: {
      listApps: mocks.listApps,
      createApp: mocks.createApp,
      deleteApp: mocks.deleteApp,
      updateAppProvisionStatus: mocks.updateAppProvisionStatus,
      updateAppDeployStatus: mocks.updateAppDeployStatus,
      deployApp: mocks.deployApp,
      finalizeDeploy: mocks.finalizeDeploy,
      getGitCredential: mocks.getGitCredential,
      revokeGitCredential: mocks.revokeGitCredential,
      getGitHead: mocks.getGitHead,
      setAppType: mocks.setAppType,
    },
  }),
}));

vi.mock("@/lib/daemon/daemon-local-client", () => ({
  encodeWorkspaceId: mocks.encodeWorkspaceId,
  seedDaemonApp: mocks.seedDaemonApp,
  cloneDaemonApp: mocks.cloneDaemonApp,
  daemonAppWorkdir: mocks.daemonAppWorkdir,
  daemonLocalAppIds: mocks.daemonLocalAppIds,
  buildDaemonApp: mocks.buildDaemonApp,
  daemonAppManifest: mocks.daemonAppManifest,
  bindDaemonAppWorkdir: mocks.bindDaemonAppWorkdir,
  getDaemonEnvActivationDiagnostics: mocks.getDaemonEnvActivationDiagnostics,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: mocks.workdirExists,
  readDir: mocks.readDir,
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

vi.mock("@/lib/apps/app-session", () => ({ bindAppWorkdir: mocks.bindAppWorkdir }));

vi.mock("@/lib/apps/app-deploy-confirm", () => ({
  publicDeployConfirm: { run: vi.fn(async () => true) },
  PUBLIC_DEPLOY_CONFIRM_MESSAGE:
    "此应用未启用登录保护，任何拿到链接的人都能访问。\n\n确定继续部署吗？",
  ACTIVE_TURN_DEPLOY_CONFIRM_MESSAGE:
    "此应用的工作区有 AI 正在运行。现在部署可能把未完成的改动打包上线。\n\n确定继续部署吗？",
}));

/** What the daemon client returns: an outcome plus where it wrote. */
const seedResult = (
  outcome: "seeded" | "failed" | "unreachable",
  over: { workdir?: string | null; error?: string | null } = {},
) => ({ outcome, workdir: null, error: null, ...over });

const buildResult = (
  outcome: "built" | "failed" | "unreachable",
  error: string | null = null,
  gitCommitSha: string | null = null,
  runtime: { runtime: string; entry: string; port: number } | null = null,
  image: string | null = null,
) => ({ outcome, error, gitCommitSha, runtime, image });

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
    mocks.cloneDaemonApp.mockResolvedValue(seedResult("unreachable"));
    mocks.daemonAppWorkdir.mockResolvedValue({
      workdir: "/home/.amuxd/teams/team-1/apps/app-1",
      deviceName: "test-host",
    });
    mocks.workdirExists.mockResolvedValue(false);
    mocks.readDir.mockResolvedValue([]);
    mocks.getGitCredential.mockResolvedValue(gitCred);
    mocks.deleteApp.mockResolvedValue(true);
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [],
      loaded: false,
      loadedKey: null,
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

  it("an empty answer is never cached", async () => {
    // The failure this exists for: a list fetched a moment before the server
    // or session finished switching comes back `[]` with a 200 — RLS filters,
    // it does not fail — and caching that told the user their apps were gone
    // until they restarted the app.
    mocks.listApps.mockResolvedValueOnce([]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    expect(useAppsStore.getState().loadedKey).toBeNull();

    mocks.listApps.mockResolvedValueOnce([appRow({ name: "Alpha" })]);
    await useAppsStore.getState().load("team-1");
    expect(mocks.listApps).toHaveBeenCalledTimes(2);
    expect(useAppsStore.getState().items).toHaveLength(1);
  });

  it("a failed load is not cached either", async () => {
    mocks.listApps.mockRejectedValueOnce(new Error("offline"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    expect(useAppsStore.getState().error).toBe("offline");
    expect(useAppsStore.getState().loadedKey).toBeNull();

    mocks.listApps.mockResolvedValueOnce([appRow()]);
    await useAppsStore.getState().load("team-1");
    expect(mocks.listApps).toHaveBeenCalledTimes(2);
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
    // The trailing `false` is "write the starter template" — the normal path.
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith(
      "app-4", "team-1", "Slides", "slides", null, null, false,
    );
  });

  it("adopting a folder binds it before the seed, and seeds no template", async () => {
    // Order is the whole of it: the seed resolves the app's workdir from this
    // binding, so binding afterwards would publish an empty default directory
    // and leave the folder the user picked unattached.
    const calls: string[] = [];
    mocks.bindDaemonAppWorkdir.mockImplementationOnce(async () => {
      calls.push("bind");
      return { workdir: "/home/me/mine", gitRemoteUrl: null };
    });
    mocks.seedDaemonApp.mockImplementationOnce(async () => {
      calls.push("seed");
      return { outcome: "seeded", workdir: "/home/me/mine", error: null };
    });
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-9", name: "Mine", type: "imported", provisionStatus: "repo_created" }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "Mine",
      type: "imported",
      visibility: "personal",
      adoptLocalDir: "/home/me/mine",
    });

    expect(calls).toEqual(["bind", "seed"]);
    expect(mocks.bindDaemonAppWorkdir).toHaveBeenCalledWith("app-9", "team-1", "/home/me/mine");
    // `adoptLocalDir` is the desktop's own field: the cloud API never sees it.
    expect(mocks.createApp).toHaveBeenCalledWith(
      expect.not.objectContaining({ adoptLocalDir: expect.anything() }),
    );
    // The 7th argument is `adoptExisting`: publish the folder, write no
    // template over it.
    const seedArgs = mocks.seedDaemonApp.mock.calls.at(-1);
    expect(seedArgs?.slice(0, 4)).toEqual(["app-9", "team-1", "Mine", "imported"]);
    expect(seedArgs?.[6]).toBe(true);
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
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "App", "fullstack_tanstack_postgres", null, null, false);
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
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "App", "fullstack_tanstack_postgres", "https://g/x.git", null, false);
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
      false,
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
      "app-1", "team-1", "App", "fullstack_tanstack_postgres", "git@github.com:owner/repo.git", null, false,
    );
  });

  it("create: the clone gets the address the user typed, not the stored one", async () => {
    // `POST /v1/apps` strips credentials before writing the row, so the row
    // comes back without them. The clone still has to authenticate, and this
    // one call is the only place the typed credential exists — losing it here
    // is how importing a private repo silently stops working.
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", gitRemoteUrl: "https://github.com/owner/private.git" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "static_web",
      visibility: "team",
      gitRemoteUrl: "https://x:ghp_token@github.com/owner/private.git",
    });
    const seedArgs = mocks.seedDaemonApp.mock.calls.at(-1);
    expect(seedArgs?.[4]).toBe("https://x:ghp_token@github.com/owner/private.git");
  });

  it("create: a clone that timed out explains what the raw error does not", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({
        id: "app-timeout",
        provisionStatus: "pending",
        gitRemoteUrl: "https://github.com/owner/private.git",
      }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) =>
      appRow({ id: "app-timeout", provisionStatus: st }),
    );
    mocks.deleteApp.mockResolvedValueOnce(true);
    mocks.seedDaemonApp.mockResolvedValueOnce(
      seedResult("failed", { error: '{"error":{"message":"git clone timed out after 5 minutes"}}' }),
    );
    const { useAppsStore } = await import("./apps-store");
    await expect(
      useAppsStore.getState().create({
        teamId: "team-1",
        name: "N",
        type: "static_web",
        visibility: "team",
        gitRemoteUrl: "https://github.com/owner/private.git",
      }),
    ).rejects.toThrow(/凭证助手/);
    expect(mocks.deleteApp).toHaveBeenCalledWith("app-timeout");
    expect(mocks.toastError).not.toHaveBeenCalled();
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
      false,
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

  it("create: a failed remote clone rolls the empty app back and throws", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({
        id: "app-orphan",
        provisionStatus: "pending",
        gitRemoteUrl: "https://github.com/owner/nope.git",
      }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) =>
      appRow({ id: "app-orphan", provisionStatus: st }),
    );
    mocks.deleteApp.mockResolvedValueOnce(true);
    mocks.seedDaemonApp.mockResolvedValueOnce(
      seedResult("failed", { error: "git clone failed: repository not found" }),
    );
    const { useAppsStore } = await import("./apps-store");
    await expect(
      useAppsStore.getState().create({
        teamId: "team-1",
        name: "N",
        type: "static_web",
        visibility: "team",
        gitRemoteUrl: "https://github.com/owner/nope.git",
      }),
    ).rejects.toThrow("git clone failed: repository not found");
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["error"]);
    expect(mocks.deleteApp).toHaveBeenCalledWith("app-orphan");
    expect(useAppsStore.getState().items).toEqual([]);
    // The form shows the error; no "clone failed" toast that would make the
    // create look half-successful.
    expect(mocks.toastError).not.toHaveBeenCalled();
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
    expect(mocks.deleteApp).not.toHaveBeenCalled();
  });

  it("reseed: a failed clone toasts and keeps the app row", async () => {
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(
      seedResult("failed", { error: "git clone failed: repository not found" }),
    );
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [
        appRow({
          provisionStatus: "error",
          gitRemoteUrl: "https://github.com/owner/nope.git",
          teamId: "team-1",
        }),
      ],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
    });
    await useAppsStore.getState().reseed("app-1");
    expect(mocks.deleteApp).not.toHaveBeenCalled();
    expect(useAppsStore.getState().items).toHaveLength(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "仓库克隆失败",
      { description: "git clone failed: repository not found" },
    );
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

describe("apps-store setType", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [appRow({ type: "data_app", fcStatus: "live" })],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
    });
  });

  it("merges the server's row, pending-redeploy flag included", async () => {
    mocks.setAppType.mockResolvedValueOnce(
      appRow({ type: "static_web", fcStatus: "live", typePendingRedeploy: true }),
    );
    const { useAppsStore } = await import("./apps-store");
    const ok = await useAppsStore.getState().setType("app-1", "static_web");

    expect(ok).toBe(true);
    expect(mocks.setAppType).toHaveBeenCalledWith("app-1", "static_web");
    expect(useAppsStore.getState().items[0]).toMatchObject({
      type: "static_web",
      typePendingRedeploy: true,
    });
  });

  it("asks the panel to recount, because the data row just changed meaning", async () => {
    // Leaving data_app has the data browser answer "no database" at once; the
    // panel loads its counts once per app and would keep showing the tables.
    mocks.setAppType.mockResolvedValueOnce(appRow({ type: "slides" }));
    const { useAppsStore } = await import("./apps-store");
    const before = useAppsStore.getState().summaryRevision;
    await useAppsStore.getState().setType("app-1", "slides");
    expect(useAppsStore.getState().summaryRevision).toBe(before + 1);
  });

  it("names the admin rule instead of relaying a bare 404", async () => {
    mocks.setAppType.mockResolvedValueOnce(null);
    const { useAppsStore } = await import("./apps-store");
    const before = useAppsStore.getState().summaryRevision;
    const ok = await useAppsStore.getState().setType("app-1", "slides");

    expect(ok).toBe(false);
    expect(useAppsStore.getState().items[0]).toMatchObject({ type: "data_app" });
    expect(useAppsStore.getState().summaryRevision).toBe(before);
    const [, opts] = mocks.toastError.mock.calls.at(-1) ?? [];
    expect(String((opts as { description?: string })?.description)).toMatch(/管理权限|admin/);
  });

  it("passes a server error through as the toast's reason", async () => {
    mocks.setAppType.mockRejectedValueOnce(new Error("type must be one of static_web, slides"));
    const { useAppsStore } = await import("./apps-store");
    const ok = await useAppsStore.getState().setType("app-1", "slides");

    expect(ok).toBe(false);
    const [, opts] = mocks.toastError.mock.calls.at(-1) ?? [];
    expect((opts as { description?: string })?.description).toBe(
      "type must be one of static_web, slides",
    );
  });
});

describe("ensureAppCheckout", () => {
  const readyGitea = (over = {}) =>
    appRow({
      provisionStatus: "ready",
      gitRemoteUrl: "git@gitea:team/app-1.git",
      gitAuthKind: "gitea_deploy_key",
      teamId: "team-1",
      ...over,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.daemonAppWorkdir.mockResolvedValue({
      workdir: "/home/.amuxd/teams/team-1/apps/app-1",
      deviceName: "test-host",
    });
    mocks.workdirExists.mockResolvedValue(false);
    mocks.readDir.mockResolvedValue([]);
    mocks.getGitCredential.mockResolvedValue(gitCred);
    mocks.cloneDaemonApp.mockResolvedValue(
      seedResult("seeded", { workdir: "/home/.amuxd/teams/team-1/apps/app-1" }),
    );
  });

  it("skips clone when the local workdir already has files", async () => {
    mocks.workdirExists.mockResolvedValueOnce(true);
    mocks.readDir.mockResolvedValueOnce([{ name: "AGENTS.md" }]);
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.cloneDaemonApp).not.toHaveBeenCalled();
    expect(mocks.getGitCredential).not.toHaveBeenCalled();
  });

  it("clones with a deploy key when the workdir is empty (Gitea-managed)", async () => {
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.getGitCredential).toHaveBeenCalledWith("app-1");
    expect(mocks.cloneDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      gitCred.remoteUrl,
      gitCred.privateKeyPem,
    );
    expect(mocks.bindAppWorkdir).toHaveBeenCalledWith(
      expect.objectContaining({ id: "app-1" }),
      "/home/.amuxd/teams/team-1/apps/app-1",
    );
  });

  it("returns the deploy key once the clone is done", async () => {
    // The server only revokes expired keys when something asks the same repo
    // for another one, so a repo that is cloned and then left alone would keep
    // every key it was ever issued.
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.revokeGitCredential).toHaveBeenCalledWith("app-1", gitCred.deployKeyId);
  });

  it("returns the deploy key even when the clone fails", async () => {
    mocks.cloneDaemonApp.mockRejectedValueOnce(new Error("daemon exploded"));
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.revokeGitCredential).toHaveBeenCalledWith("app-1", gitCred.deployKeyId);
  });

  it("a failing revoke never breaks the clone it follows", async () => {
    mocks.revokeGitCredential.mockRejectedValueOnce(new Error("cloud down"));
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.bindAppWorkdir).toHaveBeenCalled();
  });

  it("does not clone when getGitCredential is denied (view-only)", async () => {
    mocks.getGitCredential.mockResolvedValueOnce(null);
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.cloneDaemonApp).not.toHaveBeenCalled();
  });

  it("clones an imported app from gitRemoteUrl without a deploy key", async () => {
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(
      readyGitea({
        gitRemoteUrl: "https://github.com/owner/site.git",
        gitAuthKind: null,
      }),
    );
    expect(mocks.getGitCredential).not.toHaveBeenCalled();
    expect(mocks.cloneDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      "https://github.com/owner/site.git",
      null,
    );
  });

  it("toasts when clone fails", async () => {
    mocks.cloneDaemonApp.mockResolvedValueOnce(
      seedResult("failed", { error: "git clone failed: repository not found" }),
    );
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.toastError).toHaveBeenCalledWith(
      "仓库克隆失败",
      { description: "git clone failed: repository not found" },
    );
    expect(mocks.bindAppWorkdir).not.toHaveBeenCalled();
  });

  it("skips checkout for apps that are not ready yet", async () => {
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea({ provisionStatus: "pending" }));
    expect(mocks.daemonAppWorkdir).not.toHaveBeenCalled();
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
    mocks.daemonAppWorkdir.mockResolvedValue({
      workdir: "/workdir/app-1",
      deviceName: "test-host",
    });
    mocks.getGitHead.mockResolvedValue({ sha: "abc1234567890" });
    mocks.getGitCredential.mockResolvedValue(gitCred);
    // An app that declares nothing: the daemon reports the built-in contract,
    // which is what every app deployed before declarations existed gets.
    mocks.daemonAppManifest.mockResolvedValue(null);
    mocks.getDaemonEnvActivationDiagnostics.mockResolvedValue({
      workspace_has_active_turn: false,
    });
    vi.mocked(publicDeployConfirm.run).mockResolvedValue(true);
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

  it("a container app pushes an image and finalizes with it", async () => {
    // The whole point of the container path: no OSS upload handle is minted,
    // the daemon is handed a registry instead, and the image it pushed is what
    // the function is pointed at.
    mocks.daemonAppManifest.mockResolvedValue({
      runtime: "container",
      entry: "",
      port: 5000,
      healthCheckPath: "/api/health",
    });
    const image = {
      reference: "registry.cn-shenzhen.aliyuncs.com/tc/tc-app-app-1:abc1234567890",
      registry: "registry.cn-shenzhen.aliyuncs.com",
      username: "temp-user",
      password: "temp-token",
    };
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      image,
      deployToken: "tok-1",
      gitCommitSha: "abc1234567890",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(
      buildResult("built", null, null, { runtime: "container", entry: "", port: 5000 }, image.reference),
    );
    mocks.finalizeDeploy.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "live",
      fcEndpoint: "https://x.fcapp.run",
    });

    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.deployApp).toHaveBeenCalledWith("app-1", {
      gitCommitSha: "abc1234567890",
      runtime: "container",
    });
    expect(mocks.buildDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      expect.objectContaining({ image, presignedPut: undefined }),
    );
    expect(mocks.finalizeDeploy).toHaveBeenCalledWith("app-1", {
      gitCommitSha: "abc1234567890",
      runtime: { runtime: "container", entry: "", port: 5000 },
      image: image.reference,
      deployToken: "tok-1",
    });
    expect(useAppsStore.getState().items[0]).toMatchObject({ fcStatus: "live" });
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
    expect(mocks.daemonAppManifest).toHaveBeenCalledWith("app-1", "team-1");
    expect(mocks.getGitCredential).toHaveBeenCalledWith("app-1");
    expect(mocks.buildDaemonApp).toHaveBeenCalledWith("app-1", "team-1", {
      gitCommitSha: "abc1234567890",
      gitRemoteUrl: gitCred.remoteUrl,
      deployKeyPem: gitCred.privateKeyPem,
      presignedPut: "https://oss/put?sig=x",
      image: undefined,
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

  it("finalizes with the commit the daemon built, not the one we asked for", async () => {
    // A deploy publishes whatever the agent left uncommitted, so HEAD moves
    // past the sha read off Gitea before any of this started. Recording that
    // one would name a commit the running function was not built from.
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
      gitCommitSha: "abc1234567890",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(
      buildResult("built", null, "def4567890123"),
    );
    mocks.finalizeDeploy.mockResolvedValueOnce({ ...readyApp(), fcStatus: "live" });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    // The build still ASKED for the sha we resolved — publishing is the
    // daemon's decision, made once it sees the workdir.
    expect(mocks.buildDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      expect.objectContaining({ gitCommitSha: "abc1234567890" }),
    );
    expect(mocks.finalizeDeploy).toHaveBeenCalledWith("app-1", {
      gitCommitSha: "def4567890123",
      deployToken: "tok-1",
    });
  });

  it("finalizes with how the app says it starts", async () => {
    // The control plane assumed one answer for every app (node,
    // server/index.mjs, 9000). An app that builds elsewhere deployed a function
    // that could not boot, and nothing said so until the instance failed.
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
      deployToken: "tok-1",
      gitCommitSha: "abc1234567890",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce(
      buildResult("built", null, null, { runtime: "node", entry: "index.js", port: 8080 }),
    );
    mocks.finalizeDeploy.mockResolvedValueOnce({ ...readyApp(), fcStatus: "live" });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.finalizeDeploy).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ runtime: { runtime: "node", entry: "index.js", port: 8080 } }),
    );
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
    vi.mocked(publicDeployConfirm.run).mockResolvedValue(false);
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

  it("active turn prompts for deploy confirmation", async () => {
    mocks.getDaemonEnvActivationDiagnostics.mockResolvedValueOnce({
      workspace_has_active_turn: true,
    });
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

    expect(mocks.getDaemonEnvActivationDiagnostics).toHaveBeenCalledWith(
      mocks.encodeWorkspaceId("/workdir/app-1"),
      "team-1",
    );
    expect(vi.mocked(publicDeployConfirm.run)).toHaveBeenCalledTimes(1);
    expect(mocks.deployApp).toHaveBeenCalled();
  });

  it("active turn: declined confirm aborts deploy", async () => {
    mocks.getDaemonEnvActivationDiagnostics.mockResolvedValueOnce({
      workspace_has_active_turn: true,
    });
    vi.mocked(publicDeployConfirm.run).mockResolvedValue(false);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(vi.mocked(publicDeployConfirm.run)).toHaveBeenCalledTimes(1);
    expect(mocks.getGitHead).not.toHaveBeenCalled();
    expect(mocks.deployApp).not.toHaveBeenCalled();
  });

  it("unreachable env-diagnostics does not block deploy", async () => {
    mocks.getDaemonEnvActivationDiagnostics.mockResolvedValueOnce(null);
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
    expect(mocks.deployApp).toHaveBeenCalled();
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
      image: undefined,
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

  it("says an app has no code, not what pnpm called it", async () => {
    // The daemon maps ERR_PNPM_NO_PKG_MANIFEST to this marker. What reached the
    // user before was the raw pnpm line — accurate, and no help at all.
    const { mapDeployErrorReason } = await import("./apps-store");
    const raw = "app build failed: the app's folder has no package.json to build";
    expect(mapDeployErrorReason(raw)).toContain("还没有代码");
    expect(mapDeployErrorReason(raw)).not.toContain("package.json to build");
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
