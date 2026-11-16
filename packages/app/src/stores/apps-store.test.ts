import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
  deleteApp: vi.fn(),
  undeployApp: vi.fn(),
  updateAppProvisionStatus: vi.fn(),
  updateAppAuth: vi.fn(),
  updateAppDeployStatus: vi.fn(),
  deployApp: vi.fn(),
  preflightAppDeploy: vi.fn(),
  cancelAppDeployPreflight: vi.fn(),
  finalizeDeploy: vi.fn(),
  getGitCredential: vi.fn(),
  revokeGitCredential: vi.fn(),
  setGitHttpsCredential: vi.fn(),
  clearGitHttpsCredential: vi.fn(),
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
      updateAppAuth: mocks.updateAppAuth,
      createApp: mocks.createApp,
      deleteApp: mocks.deleteApp,
      undeployApp: mocks.undeployApp,
      updateAppProvisionStatus: mocks.updateAppProvisionStatus,
      updateAppDeployStatus: mocks.updateAppDeployStatus,
      deployApp: mocks.deployApp,
      preflightAppDeploy: mocks.preflightAppDeploy,
      cancelAppDeployPreflight: mocks.cancelAppDeployPreflight,
      finalizeDeploy: mocks.finalizeDeploy,
      getGitCredential: mocks.getGitCredential,
      revokeGitCredential: mocks.revokeGitCredential,
      setGitHttpsCredential: mocks.setGitHttpsCredential,
      clearGitHttpsCredential: mocks.clearGitHttpsCredential,
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

/** What the daemon client returns: an outcome plus where it wrote. */
const seedResult = (
  outcome: "seeded" | "failed" | "unreachable",
  over: { workdir?: string | null; error?: string | null } = {},
) => ({ outcome, workdir: null, error: null, ...over });

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
  startSpec: null,
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
    // The create response has no relationship; whoever created it owns it.
    expect(useAppsStore.getState().items[0].relationship).toBe("owner");
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

  it("create: a per-account app tells the daemon its HTTPS address", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({
        provisionStatus: "repo_created",
        gitRemoteUrl: "ssh://git@gitea:2222/o1/tc-app-app-1.git",
        gitAuthKind: "gitea_deploy_key",
        gitAccountAuth: true,
        gitHttpUrl: "https://gitea/o1/tc-app-app-1.git",
      }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({ teamId: "team-1", name: "N", type: "static_web", visibility: "team" });
    // The seed push still goes over SSH with the deploy key; the HTTPS address
    // is for whoever uses the checkout afterwards.
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      "App",
      "fullstack_tanstack_postgres",
      "ssh://git@gitea:2222/o1/tc-app-app-1.git",
      gitCred.privateKeyPem,
      false,
      null,
      "https://gitea/o1/tc-app-app-1.git",
    );
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
      seedResult("failed", { error: "git clone failed: early EOF" }),
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
    ).rejects.toThrow("git clone failed: early EOF");
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
      seedResult("failed", { error: "git clone failed: early EOF" }),
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
      { description: "git clone failed: early EOF" },
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

  it("keeps the relationship the list gave the row, which a mutation response omits", async () => {
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [appRow({ type: "data_app", relationship: "invited", invitedByActorId: "actor-lin" })],
    });
    mocks.setAppType.mockResolvedValueOnce(appRow({ type: "static_web" }));

    await useAppsStore.getState().setType("app-1", "static_web");

    expect(useAppsStore.getState().items[0]).toMatchObject({
      type: "static_web",
      relationship: "invited",
      invitedByActorId: "actor-lin",
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
      seedResult("failed", { error: "git clone failed: early EOF" }),
    );
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea());
    expect(mocks.toastError).toHaveBeenCalledWith(
      "仓库克隆失败",
      { description: "git clone failed: early EOF" },
    );
    expect(mocks.bindAppWorkdir).not.toHaveBeenCalled();
  });

  it("skips checkout for apps that are not ready yet", async () => {
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(readyGitea({ provisionStatus: "pending" }));
    expect(mocks.daemonAppWorkdir).not.toHaveBeenCalled();
  });
});

describe("apps-store undeploy and delete", () => {
  let useAppsStore: typeof import("./apps-store").useAppsStore;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ useAppsStore } = await import("./apps-store"));
    useAppsStore.setState({ items: [appRow({ id: "app-1", fcStatus: "live" })], selectedAppId: "app-1" } as never);
  });

  it("merges the accepted undeploy row; completion is left to status polling", async () => {
    const operation = { id: "op-1", appId: "app-1", status: "pending", steps: {} };
    mocks.undeployApp.mockResolvedValueOnce({
      app: appRow({ id: "app-1", fcStatus: "uninstalling", undeployOperation: operation }),
      operation,
    });
    expect(await useAppsStore.getState().undeployApp("app-1")).toBe(true);
    expect(useAppsStore.getState().items[0]).toMatchObject({ id: "app-1", fcStatus: "uninstalling" });
  });

  it("toasts a rejected undeploy and leaves the row alone", async () => {
    mocks.undeployApp.mockRejectedValueOnce(new Error("conflict"));
    expect(await useAppsStore.getState().undeployApp("app-1")).toBe(false);
    expect(useAppsStore.getState().items[0]).toMatchObject({ fcStatus: "live" });
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("drops a deleted app and clears its selection", async () => {
    mocks.deleteApp.mockResolvedValueOnce(true);
    expect(await useAppsStore.getState().deleteApp("app-1")).toBe(true);
    expect(useAppsStore.getState().items).toEqual([]);
    expect(useAppsStore.getState().selectedAppId).toBeNull();
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

describe("apps-store: private repo credentials", () => {
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

  it("create: a private https import stores its token first, then clones with it", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", gitRemoteUrl: "https://github.com/owner/private.git" }),
    );
    mocks.setGitHttpsCredential.mockResolvedValueOnce(
      appRow({
        provisionStatus: "pending",
        gitRemoteUrl: "https://github.com/owner/private.git",
        gitAuthKind: "https_token",
      }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) => appRow({ provisionStatus: st }));
    mocks.seedDaemonApp.mockResolvedValueOnce(seedResult("seeded"));
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "imported",
      visibility: "team",
      gitRemoteUrl: "https://github.com/owner/private.git",
      gitCredential: { username: "me", token: "ghp_abc" },
    });
    expect(mocks.createApp.mock.calls[0][0]).not.toHaveProperty("gitCredential");
    expect(mocks.setGitHttpsCredential).toHaveBeenCalledWith("app-1", { username: "me", token: "ghp_abc" });
    expect(mocks.setGitHttpsCredential.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.seedDaemonApp.mock.invocationCallOrder[0],
    );
    expect(mocks.seedDaemonApp.mock.calls.at(-1)?.[7]).toEqual({ username: "me", token: "ghp_abc" });
    // The token typed a moment ago is the one used, not read back from the cloud.
    expect(mocks.getGitCredential).not.toHaveBeenCalled();
  });

  it("create: a token that cannot be stored drops the app before any clone", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-tok", provisionStatus: "pending", gitRemoteUrl: "https://github.com/owner/private.git" }),
    );
    mocks.setGitHttpsCredential.mockRejectedValueOnce(new Error("app secrets not configured"));
    const { useAppsStore } = await import("./apps-store");
    await expect(
      useAppsStore.getState().create({
        teamId: "team-1",
        name: "N",
        type: "imported",
        visibility: "team",
        gitRemoteUrl: "https://github.com/owner/private.git",
        gitCredential: { username: "", token: "ghp_abc" },
      }),
    ).rejects.toThrow(/app secrets not configured/);
    expect(mocks.deleteApp).toHaveBeenCalledWith("app-tok");
    expect(mocks.seedDaemonApp).not.toHaveBeenCalled();
    expect(useAppsStore.getState().items.some((a) => a.id === "app-tok")).toBe(false);
  });

  it("create: a clone refused for want of a login says the repo needs one", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-auth", provisionStatus: "pending", gitRemoteUrl: "https://github.com/owner/private.git" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, st) =>
      appRow({ id: "app-auth", provisionStatus: st }),
    );
    mocks.seedDaemonApp.mockResolvedValueOnce(
      seedResult("failed", {
        error:
          "git clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      }),
    );
    const { useAppsStore } = await import("./apps-store");
    await expect(
      useAppsStore.getState().create({
        teamId: "team-1",
        name: "N",
        type: "imported",
        visibility: "team",
        gitRemoteUrl: "https://github.com/owner/private.git",
      }),
    ).rejects.toThrow(/需要登录/);
  });

  it("download: an import with a stored token clones with it", async () => {
    mocks.getGitCredential.mockResolvedValueOnce({
      remoteUrl: "https://github.com/owner/private.git",
      authKind: "https_token",
      username: "me",
      token: "tok",
    });
    mocks.cloneDaemonApp.mockResolvedValueOnce(seedResult("seeded", { workdir: "/w/app-1" }));
    const { ensureAppCheckout } = await import("./apps-store");
    const workdir = await ensureAppCheckout(
      appRow({
        provisionStatus: "ready",
        gitRemoteUrl: "https://github.com/owner/private.git",
        gitAuthKind: "https_token",
      }),
    );
    expect(workdir).toBe("/w/app-1");
    expect(mocks.cloneDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      "https://github.com/owner/private.git",
      null,
      { username: "me", token: "tok" },
    );
    expect(mocks.revokeGitCredential).not.toHaveBeenCalled();
  });

  it("download: an import with no stored token never asks for one", async () => {
    mocks.cloneDaemonApp.mockResolvedValueOnce(seedResult("seeded", { workdir: "/w/app-1" }));
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(
      appRow({ provisionStatus: "ready", gitRemoteUrl: "https://github.com/owner/public.git" }),
    );
    expect(mocks.getGitCredential).not.toHaveBeenCalled();
    expect(mocks.cloneDaemonApp).toHaveBeenCalledWith(
      "app-1",
      "team-1",
      "https://github.com/owner/public.git",
      null,
    );
  });

  it("saveGitCredential: a 404 is explained as the admin rule", async () => {
    mocks.setGitHttpsCredential.mockRejectedValueOnce(
      Object.assign(new Error("app not found"), { status: 404 }),
    );
    const { useAppsStore } = await import("./apps-store");
    expect(await useAppsStore.getState().saveGitCredential("app-1", { token: "t" })).toBe(false);
    expect(JSON.stringify(mocks.toastError.mock.calls)).toContain("管理员");
  });

  it("download: an import whose first clone failed can still be downloaded, and becomes ready", async () => {
    // Its status only says the creator's clone failed; the repository is there.
    mocks.cloneDaemonApp.mockResolvedValueOnce(seedResult("seeded", { workdir: "/w/app-1" }));
    mocks.updateAppProvisionStatus.mockResolvedValueOnce(
      appRow({ provisionStatus: "ready", gitRemoteUrl: "https://github.com/owner/site.git" }),
    );
    const { ensureAppCheckout } = await import("./apps-store");
    const workdir = await ensureAppCheckout(
      appRow({ provisionStatus: "error", gitRemoteUrl: "https://github.com/owner/site.git" }),
      { surfaceErrors: true },
    );
    expect(workdir).toBe("/w/app-1");
    expect(mocks.cloneDaemonApp).toHaveBeenCalled();
    expect(mocks.updateAppProvisionStatus).toHaveBeenCalledWith("app-1", "ready");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("download: a repository the forge will not show says which two things that means", async () => {
    // What GitHub answers for a repo that is gone AND for a private one the
    // caller has no token for — the same 404 either way. Git's own sentence
    // names neither, and the two repairs are different.
    mocks.cloneDaemonApp.mockResolvedValueOnce(
      seedResult("failed", {
        error:
          "git clone failed: fatal: repository 'https://github.com/owner/gone.git/' not found",
      }),
    );
    const { ensureAppCheckout } = await import("./apps-store");
    const workdir = await ensureAppCheckout(
      appRow({ provisionStatus: "ready", gitRemoteUrl: "https://github.com/owner/gone.git" }),
      { surfaceErrors: true },
    );
    expect(workdir).toBeNull();
    const [title, opts] = mocks.toastError.mock.calls.at(-1) ?? [];
    const description = String((opts as { description?: string })?.description);
    expect(title).toBe("仓库克隆失败");
    // The address it could not open, then both causes, then where to fix each.
    expect(description).toContain("https://github.com/owner/gone.git");
    expect(description).toContain("私有");
    expect(description).not.toContain("fatal:");
  });

  it("download: a forge that says 'Repository not found' without an address still explains itself", async () => {
    // The SSH wording. No URL to quote, so the sentence carries the causes only.
    mocks.cloneDaemonApp.mockResolvedValueOnce(
      seedResult("failed", { error: "git clone failed: ERROR: Repository not found." }),
    );
    const { ensureAppCheckout } = await import("./apps-store");
    await ensureAppCheckout(
      appRow({ provisionStatus: "ready", gitRemoteUrl: "https://github.com/owner/gone.git" }),
      { surfaceErrors: true },
    );
    const [, opts] = mocks.toastError.mock.calls.at(-1) ?? [];
    const description = String((opts as { description?: string })?.description);
    expect(description).toContain("私有");
    expect(description).not.toContain("Repository not found");
  });

  it("download: a hosted app that was never seeded is still refused", async () => {
    // Its repository would clone empty.
    const { ensureAppCheckout } = await import("./apps-store");
    const workdir = await ensureAppCheckout(
      appRow({
        provisionStatus: "error",
        gitRemoteUrl: "git@gitea:team/app-1.git",
        gitAuthKind: "gitea_deploy_key",
      }),
      { surfaceErrors: true },
    );
    expect(workdir).toBeNull();
    expect(mocks.cloneDaemonApp).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.toastError.mock.calls)).toContain("尚未就绪");
  });
});


describe('auth policy save outcomes', () => {
  it('keeps the original stored row after a rejected write', async () => {
    const { useAppsStore } = await import('./apps-store')
    const row = { id: 'auth-app', authScope: 'paths', authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] } as never
    useAppsStore.setState({ items: [row] })
    mocks.updateAppAuth.mockRejectedValueOnce(new Error('unknown organization role'))
    expect(await useAppsStore.getState().updateAuthPolicy('auth-app', { authRules: [{ path: '/staff', auth: 'required', roles: ['missing'] }] })).toBe(false)
    expect(useAppsStore.getState().items).toEqual([row])
  })
  it('uses the returned server row rather than the submitted draft', async () => {
    const { useAppsStore } = await import('./apps-store')
    const server = { id: 'auth-app', authScope: 'paths', authRules: [{ path: '/staff', auth: 'required', audience: 'org' }] }
    useAppsStore.setState({ items: [{ ...server, authRules: [] } as never] })
    mocks.updateAppAuth.mockResolvedValueOnce(server)
    expect(await useAppsStore.getState().updateAuthPolicy('auth-app', { authRules: [] })).toBe(true)
    expect(useAppsStore.getState().items[0].authRules).toEqual(server.authRules)
  })
})
