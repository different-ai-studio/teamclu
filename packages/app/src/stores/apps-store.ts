import { create, type StoreApi } from "zustand";
import { getBackend } from "@/lib/backend";
import {
  ACTIVE_TURN_DEPLOY_CONFIRM_MESSAGE,
  PUBLIC_DEPLOY_CONFIRM_MESSAGE,
  publicDeployConfirm,
} from "@/lib/app-deploy-confirm";
import {
  seedDaemonApp,
  buildDaemonApp,
  cloneDaemonApp,
  daemonAppWorkdir,
  daemonLocalAppIds,
  encodeWorkspaceId,
  getDaemonEnvActivationDiagnostics,
  type BuildAppResult,
  type SeedAppResult,
} from "@/lib/daemon-local-client";
import { isTauri } from "@/lib/utils";
import i18n from "@/lib/i18n";
import type { AppRow, AppAuthMode } from "@/lib/backend/types";

interface AppsState {
  items: AppRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  teamId: string | null;
  /** App ids with a deploy in flight — drives per-row spinner / disabled state. */
  deployingIds: string[];
  /** Per-app deploy phase for the column footer progress bar. */
  deployProgressByAppId: Record<string, DeployProgress>;
  /** Last session opened for each app — a hint for re-open, not a 1:1 binding. */
  sessionIdByAppId: Record<string, string>;
  /** Reverse map for control-panel app resolution (session → app). */
  appIdBySessionId: Record<string, string>;
  /** App highlighted in column 1; drives column 2 session list when filter is apps. */
  selectedAppId: string | null;
  /**
   * Ids of the apps this machine holds a checkout for, or null when the daemon
   * has not answered yet.
   *
   * Null is not "none": the sidebar shows every app until the daemon reports,
   * because a daemon that is merely slow to start must not make the list look
   * empty and send the user off to download apps they already have.
   */
  localAppIds: string[] | null;
  recordAppSession: (appId: string, sessionId: string) => void;
  selectApp: (appId: string | null) => void;
  load: (teamId: string, opts?: { force?: boolean }) => Promise<void>;
  create: (input: {
    teamId: string;
    name: string;
    type: string;
    visibility: "personal" | "team";
    /** Optional repo to import — the app is cloned from it instead of seeded
     *  with a starter template. */
    gitRemoteUrl?: string | null;
    /** The code is a checkout already on this machine: no repo is provisioned
     *  and no template is written. Set by the "browse a local directory" path. */
    localOnly?: boolean;
  }) => Promise<AppRow>;
  /** Re-ask the daemon which apps are on this machine. */
  refreshLocalApps: (teamId?: string | null) => Promise<void>;
  /** Clone a team app onto this machine (the library dialog's "download"). */
  download: (app: AppRow) => Promise<void>;
  reseed: (appId: string) => Promise<void>;
  /** Full FC deploy: startDeploy → daemon build+upload → finalize. */
  deploy: (appId: string) => Promise<void>;
  rename: (appId: string, name: string) => Promise<void>;
  updateAuthMode: (appId: string, authMode: AppAuthMode) => Promise<void>;
  deleteApp: (appId: string) => Promise<boolean>;
}

type SetState = StoreApi<AppsState>["setState"];

export type DeployPhase = "prepare" | "build" | "finalize" | "done";

interface DeployProgress {
  phase: DeployPhase;
  startedAt: number;
}

function setDeployProgress(set: SetState, appId: string, phase: DeployPhase): void {
  set((s) => ({
    deployProgressByAppId: {
      ...s.deployProgressByAppId,
      [appId]: { phase, startedAt: Date.now() },
    },
  }));
}

function clearDeployProgress(set: SetState, appId: string): void {
  set((s) => {
    if (!(appId in s.deployProgressByAppId)) return s;
    const next = { ...s.deployProgressByAppId };
    delete next[appId];
    return { deployProgressByAppId: next };
  });
}

/** Merge a fresh app row (from create/deploy/rename responses) into the store. */
function mergeRow(set: SetState, row: AppRow): void {
  set((s) => ({ items: s.items.map((a) => (a.id === row.id ? row : a)) }));
}

async function toastError(title: string, description?: string): Promise<void> {
  const { toast } = await import("sonner");
  toast.error(title, description ? { description } : undefined);
}

/**
 * Write a terminal provision status back to the cloud API and patch the matching
 * row in the store. Non-fatal: a failed writeback must never reject the caller
 * (app creation / reseed has already succeeded locally).
 */
async function patchStatus(set: SetState, appId: string, status: string): Promise<void> {
  try {
    const updated = await getBackend().apps.updateAppProvisionStatus(appId, status);
    if (updated) set((s) => ({ items: s.items.map((a) => (a.id === appId ? updated : a)) }));
  } catch (e) {
    console.warn("app status writeback failed (non-fatal)", e);
  }
}

/**
 * Report a failed deploy back to the cloud API so `fc_status` lands on
 * `deploy_error` with a reason. The desktop drives the middle of the deploy (it
 * kicks the daemon build), so nothing else can tell the cloud the build never
 * finished — without this the row stays at `awaiting_build` forever and the
 * next finalize is rejected as an illegal transition. Non-fatal: the user is
 * already being toasted about the failure.
 */
async function reportDeployError(set: SetState, appId: string, reason: string): Promise<void> {
  try {
    const updated = await getBackend().apps.updateAppDeployStatus(appId, "deploy_error", reason);
    if (updated) mergeRow(set, updated);
  } catch (e) {
    console.warn("deploy error writeback failed (non-fatal)", e);
  }
}

/**
 * Map daemon / cloud errors to short copy for deploy toasts.
 *
 * STR-12: this used to return Chinese string literals, so an English-locale
 * user got a deploy failure explained in Chinese — and the strings were
 * invisible to the locale parity test, which is the guard that would otherwise
 * have caught it.
 */
export function mapDeployErrorReason(raw: string): string {
  const lower = raw.toLowerCase();
  if (raw.includes("uncommitted or unpushed")) {
    return i18n.t(
      "apps.deployErrorReason.uncommitted",
      "The workspace has uncommitted or unpushed changes. Commit and push, then deploy.",
    );
  }
  if (lower.includes("pnpm install timed out")) {
    return i18n.t(
      "apps.deployErrorReason.installTimeout",
      "Dependency install timed out after 10 minutes. Check the network or the lockfile, then retry.",
    );
  }
  if (lower.includes("pnpm build timed out")) {
    return i18n.t(
      "apps.deployErrorReason.buildTimeout",
      "Build timed out after 10 minutes. Check the build script, then retry.",
    );
  }
  if (lower.includes("artifact exceeds") || lower.includes("50 mib")) {
    return i18n.t(
      "apps.deployErrorReason.artifactTooLarge",
      "Build output is over the 50 MiB limit. Trim it, then retry.",
    );
  }
  if (lower.includes("presigned") || lower.includes("upload url expired")) {
    return i18n.t(
      "apps.deployErrorReason.uploadUrlExpired",
      "The upload link expired. Start the deploy again.",
    );
  }
  if (lower.includes("unsupported_auth_mode") || lower.includes("third-party login")) {
    return i18n.t(
      "apps.deployErrorReason.unsupportedAuthMode",
      "Third-party login cannot be deployed yet. Switch to platform login or no login.",
    );
  }
  if (lower.includes("vanity_required") || lower.includes("apps public domain")) {
    return i18n.t(
      "apps.deployErrorReason.vanityRequired",
      "Platform login needs a public domain for apps (APPS_PUBLIC_DOMAIN).",
    );
  }
  if (lower.includes("git commit not found on remote")) {
    return i18n.t(
      "apps.deployErrorReason.commitNotOnRemote",
      "That commit is not on Gitea. Push it, then deploy.",
    );
  }
  if (lower.includes("lockfile out of sync")) {
    return i18n.t(
      "apps.deployErrorReason.lockfileOutOfSync",
      "pnpm-lock.yaml does not match package.json. Commit the lockfile, then retry.",
    );
  }
  if (lower.includes("build output missing")) {
    return i18n.t(
      "apps.deployErrorReason.buildOutputMissing",
      "The build produced no .output/ directory. Check the build script.",
    );
  }
  // Last, and on whole phrases only. Matching the bare substring "amuxd" put
  // this first and swallowed every real build failure whose message quotes the
  // workdir path (`~/.amuxd/teams/…`) — the user was told the daemon was down
  // while it was running fine and the actual cause was discarded.
  if (
    lower.includes("daemon is not connected") ||
    lower.includes("cannot reach amuxd") ||
    lower.includes("amuxd is not running")
  ) {
    return i18n.t(
      "apps.deployErrorReason.daemonNotConnected",
      "The local amuxd is not connected, so nothing can build. Make sure the daemon is running, then retry.",
    );
  }
  return raw;
}

/**
 * Whether this deployment provisioned the app's repo on Gitea and holds a
 * deploy key for it.
 *
 * False for an app imported from someone else's remote: it has no
 * `tc-app-<id>` repo, so `git-head` and `git-credential` both 404 on it and
 * its deploy has to build the local workdir instead.
 */
function isGiteaManaged(app: Pick<AppRow, "gitAuthKind">): boolean {
  return app.gitAuthKind === "gitea_deploy_key";
}

function mapCloudDeployError(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const err = e as { code: unknown; message: unknown };
    if (typeof err.code === "string" && typeof err.message === "string") {
      return mapDeployErrorReason(`${err.code}: ${err.message}`);
    }
  }
  return mapDeployErrorReason(e instanceof Error ? e.message : String(e));
}

/**
 * Kick the local daemon seed and write back the terminal status. The desktop
 * writes ONLY `ready`/`error`; `unreachable` writes nothing so the row stays
 * `pending` and a reseed remains available.
 *
 * The daemon reports the directory it wrote to, and that path is written onto
 * the app's own cloud workspace row right here — before any session exists.
 * Leaving it for the session-open path meant the app's workspace stayed
 * path-less until then, and a path-less workspace is one the daemon resolves by
 * falling back to whatever folder the desktop had open.
 *
 * A clone that fails is the one case worth interrupting the user for: they
 * typed the URL, and the app is empty until they fix it.
 */
async function runSeed(set: SetState, app: AppRow): Promise<void> {
  let deployKeyPem: string | null = null;
  let deployKeyId: number | null = null;
  // Keyed on how the repo is authenticated, not on the status the row happens
  // to be sitting at. Requiring `repo_created` meant a reseed — which is
  // offered on `pending` and `error` — fetched no deploy key and fell into the
  // clone-only path: the daemon then refused to clone over the template, or
  // (worse, on an empty workdir) cloned the empty Gitea repo and reported the
  // app ready with no files in it.
  const needsGiteaPush = isGiteaManaged(app) && !!app.gitRemoteUrl?.trim();
  if (needsGiteaPush) {
    try {
      const cred = await getBackend().apps.getGitCredential(app.id);
      deployKeyPem = cred?.privateKeyPem ?? null;
      deployKeyId = cred?.deployKeyId ?? null;
      if (!deployKeyPem) {
        await patchStatus(set, app.id, "error");
        await toastError("仓库初始化失败", "无法获取 Gitea 部署密钥");
        return;
      }
    } catch (e) {
      console.warn("getGitCredential failed (non-fatal)", e);
      await patchStatus(set, app.id, "error");
      await toastError("仓库初始化失败", e instanceof Error ? e.message : String(e));
      return;
    }
  }

  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    result = await seedDaemonApp(
      app.id,
      app.teamId,
      app.name,
      app.type,
      app.gitRemoteUrl,
      deployKeyPem,
    );
  } catch (e) {
    console.warn("app seed kick failed (non-fatal)", e);
  } finally {
    await returnGitCredential(app.id, deployKeyId);
  }
  if (result.outcome === "seeded") {
    if (result.workdir) {
      // Dynamic: app-session pulls in the session-creation chain, which reads
      // this store.
      const { bindAppWorkdir } = await import("@/lib/app-session");
      await bindAppWorkdir(app, result.workdir);
    }
    await patchStatus(set, app.id, "ready");
  } else if (result.outcome === "failed") {
    await patchStatus(set, app.id, "error");
    if (app.gitRemoteUrl) {
      await toastError("仓库克隆失败", result.error ?? undefined);
    }
  }
  // unreachable → no status change; reseed remains available.
}

/**
 * Give a minted deploy key back now that the daemon has finished with it.
 *
 * The server revokes expired keys only when something asks the same repo for
 * another one, so a repo that is seeded or deployed and then left alone keeps
 * every key it was ever issued. Returning it here is what makes that bound
 * real. Never throws and never blocks the outcome — the work it follows has
 * already happened.
 */
async function returnGitCredential(appId: string, deployKeyId: number | null): Promise<void> {
  if (deployKeyId == null) return;
  try {
    await getBackend().apps.revokeGitCredential(appId, deployKeyId);
  } catch (e) {
    console.warn("revokeGitCredential failed (non-fatal)", e);
  }
}

/** True when the daemon workdir already has a checkout (non-empty directory). */
async function localWorkdirHasCheckout(workdir: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { exists, readDir } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(workdir))) return false;
    const entries = await readDir(workdir);
    return entries.length > 0;
  } catch (e) {
    console.warn("could not inspect app workdir (non-fatal)", e);
    return false;
  }
}

/**
 * On-demand clone for collaborators (design §5.4): when this machine has no
 * local checkout yet, fetch the repo with a prompt+ deploy key and bind the
 * workdir. Skips when the directory already has files; dirty trees are left
 * alone (deploy/build reuse ERR_DIRTY — we never clone over them).
 */
export async function ensureAppCheckout(
  app: AppRow,
  opts: { surfaceErrors?: boolean } = {},
): Promise<void> {
  // Every early return below is silent on the automatic path — it fires on
  // selection, where a toast about a daemon that is still starting would be
  // noise. A download the user clicked is the opposite: saying nothing looks
  // like a dead button, so `surfaceErrors` turns each one into a reason.
  const { surfaceErrors = false } = opts;
  const bail = async (reason: string) => {
    if (surfaceErrors) await toastError("下载失败", reason);
  };

  if (!isTauri()) return;
  if (app.provisionStatus !== "ready") {
    await bail("应用尚未就绪");
    return;
  }

  const workdirInfo = await daemonAppWorkdir(app.id, app.teamId);
  if (!workdirInfo) {
    await bail(mapDeployErrorReason("amuxd daemon is not connected"));
    return;
  }
  const workdir = workdirInfo.workdir;
  if (await localWorkdirHasCheckout(workdir)) return;

  let gitRemoteUrl: string | null = app.gitRemoteUrl?.trim() || null;
  let deployKeyPem: string | null = null;
  let deployKeyId: number | null = null;

  if (isGiteaManaged(app)) {
    try {
      const cred = await getBackend().apps.getGitCredential(app.id);
      if (!cred?.privateKeyPem || !cred.remoteUrl) {
        await bail("没有这个应用仓库的访问权限");
        return;
      }
      gitRemoteUrl = cred.remoteUrl;
      deployKeyPem = cred.privateKeyPem;
      deployKeyId = cred.deployKeyId ?? null;
    } catch (e) {
      console.warn("getGitCredential failed during checkout (non-fatal)", e);
      await bail(e instanceof Error ? e.message : String(e));
      return;
    }
  } else if (!gitRemoteUrl) {
    // An app with no remote of any kind has nothing to fetch — its code only
    // ever existed on the machine that made it.
    await bail("这个应用没有可下载的仓库地址");
    return;
  }

  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    result = await cloneDaemonApp(app.id, app.teamId, gitRemoteUrl, deployKeyPem);
  } catch (e) {
    console.warn("app clone kick failed (non-fatal)", e);
  } finally {
    await returnGitCredential(app.id, deployKeyId);
  }

  if (result.outcome === "seeded" && result.workdir) {
    const { bindAppWorkdir } = await import("@/lib/app-session");
    await bindAppWorkdir(app, result.workdir);
  } else if (result.outcome === "failed") {
    await toastError("仓库克隆失败", result.error ?? undefined);
  }
}

export const useAppsStore = create<AppsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,
  teamId: null,
  deployingIds: [],
  deployProgressByAppId: {},
  sessionIdByAppId: {},
  appIdBySessionId: {},
  selectedAppId: null,
  localAppIds: null,
  recordAppSession: (appId, sessionId) => {
    set((s) => {
      const sessionChanged = s.sessionIdByAppId[appId] !== sessionId;
      const appChanged = s.appIdBySessionId[sessionId] !== appId;
      if (!sessionChanged && !appChanged) return s;
      return {
        sessionIdByAppId: sessionChanged
          ? { ...s.sessionIdByAppId, [appId]: sessionId }
          : s.sessionIdByAppId,
        appIdBySessionId: appChanged
          ? { ...s.appIdBySessionId, [sessionId]: appId }
          : s.appIdBySessionId,
      };
    });
  },
  selectApp: (appId) => {
    set((s) => (s.selectedAppId === appId ? s : { selectedAppId: appId }));
  },
  load: async (teamId, opts) => {
    const s = get();
    if (s.loaded && s.teamId === teamId && !opts?.force) return;
    set({ loading: true, error: null, teamId });
    try {
      const items = await getBackend().apps.listApps(teamId);
      set({ items, loaded: true, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "failed to load apps",
      });
    }
  },
  create: async (input) => {
    const row = await getBackend().apps.createApp(input);
    set((s) => ({ items: [row, ...s.items] }));
    // A local checkout is already on disk and comes back `ready`; seeding it
    // would write the starter template over the user's own files. The guard is
    // the status rather than the flag so an app that somehow arrives `ready` by
    // another route is treated the same way.
    if (row.provisionStatus === "pending" || row.provisionStatus === "repo_created") {
      // The cloud API only inserts the row; the app's files come from the local
      // daemon, which writes its own embedded template. Non-fatal — a daemon
      // that is down (unreachable) leaves the row `pending` so the user can
      // reseed.
      await runSeed(set, row);
    }
    await get().refreshLocalApps(input.teamId);
    // Return the row as it stands AFTER seeding — the caller decides what to do
    // next based on whether the app actually has its files.
    return get().items.find((a) => a.id === row.id) ?? row;
  },
  refreshLocalApps: async (teamId) => {
    if (!isTauri()) return;
    const team = teamId ?? get().teamId;
    const ids = await daemonLocalAppIds(team);
    // A null answer means the daemon did not reply. Keep whatever we had —
    // overwriting it with "nothing is local" would empty the sidebar every time
    // the daemon restarts.
    if (ids === null) return;
    set({ localAppIds: ids });
  },
  download: async (app) => {
    await ensureAppCheckout(app, { surfaceErrors: true });
    await get().refreshLocalApps(app.teamId);
  },
  reseed: async (appId) => {
    const app = get().items.find((a) => a.id === appId);
    if (!app) return;
    await runSeed(set, app);
  },
  deploy: async (appId) => {
    const app = get().items.find((a) => a.id === appId);
    if (!app) return;
    if (get().deployingIds.includes(appId)) return;
    if (app.provisionStatus !== "ready") {
      await toastError("应用尚未就绪，无法部署");
      return;
    }

    if (app.workspaceId) {
      // Daemon `/v1/workspaces/:id/*` routes take a base64url-encoded absolute
      // path, not the cloud workspace UUID stored on the app row.
      const workdirInfo = await daemonAppWorkdir(app.id, app.teamId);
      const workspacePath = workdirInfo?.workdir?.trim();
      if (workspacePath) {
        const envDiag = await getDaemonEnvActivationDiagnostics(
          encodeWorkspaceId(workspacePath),
          app.teamId,
        );
        if (envDiag?.workspace_has_active_turn) {
          const accepted = await publicDeployConfirm.run(ACTIVE_TURN_DEPLOY_CONFIRM_MESSAGE);
          if (!accepted) return;
        }
      }
    }

    if (app.authMode === "none") {
      const accepted = await publicDeployConfirm.run(PUBLIC_DEPLOY_CONFIRM_MESSAGE);
      if (!accepted) return;
    }

    set((s) => ({ deployingIds: [...s.deployingIds, appId] }));
    setDeployProgress(set, appId, "prepare");
    try {
      // Only a Gitea-managed app deploys a commit off the forge. An imported
      // app has no repo of ours and no credential for the one it came from, so
      // it deploys the workdir as it sits — which is how it worked before
      // Gitea existed, and going through Gitea unconditionally broke it.
      const viaGitea = isGiteaManaged(app);
      let gitCommitSha: string | undefined;
      if (viaGitea) {
        const head = await getBackend().apps.getGitHead(appId);
        if (!head?.sha) {
          throw new Error("无法读取 Gitea 默认分支 HEAD，请确认仓库已 push");
        }
        gitCommitSha = head.sha;
      }

      const started = await getBackend().apps.deployApp(
        appId,
        gitCommitSha ? { gitCommitSha } : {},
      );
      mergeRow(set, started);

      setDeployProgress(set, appId, "build");
      let gitRemoteUrl: string | undefined;
      let deployKeyPem: string | undefined;
      let deployKeyId: number | null = null;
      if (viaGitea) {
        const cred = await getBackend().apps.getGitCredential(appId);
        if (!cred?.privateKeyPem || !cred.remoteUrl) {
          throw new Error("无法获取 Gitea 部署凭证");
        }
        gitRemoteUrl = cred.remoteUrl;
        deployKeyPem = cred.privateKeyPem;
        deployKeyId = cred.deployKeyId ?? null;
      }

      let build: BuildAppResult;
      try {
        build = await buildDaemonApp(appId, app.teamId, {
          gitCommitSha,
          gitRemoteUrl,
          deployKeyPem,
          presignedPut: started.presignedPut,
        });
      } finally {
        // The daemon only needs the key for the fetch inside the build; hand it
        // back whether that succeeded or not.
        await returnGitCredential(appId, deployKeyId);
      }
      if (build.outcome !== "built") {
        const reason =
          build.outcome === "unreachable"
            ? mapDeployErrorReason("amuxd daemon is not connected")
            : mapDeployErrorReason(build.error ?? "应用构建或上传失败");
        await reportDeployError(set, appId, reason);
        await toastError("部署失败：构建未完成", reason);
        return;
      }

      // No success toast. It showed `fcEndpoint` — the raw FC function URL —
      // which is not the address the product hands out (that is the app's
      // vanity domain, and the row already carries it into the UI). A popup
      // naming the wrong host on every deploy is worse than no popup: the
      // merged row flips the row to live on its own.
      setDeployProgress(set, appId, "finalize");
      const finalized = await getBackend().apps.finalizeDeploy(appId, {
        ...(gitCommitSha ? { gitCommitSha } : {}),
        deployToken: started.deployToken,
      });
      // The merged row carries `authModePendingRedeploy` straight from the
       // server, so a successful finalize clears the warning on its own — there
       // is no local flag left to reset here.
      mergeRow(set, finalized);
      setDeployProgress(set, appId, "done");
    } catch (e) {
      const reason = mapCloudDeployError(e);
      await reportDeployError(set, appId, reason);
      await toastError(i18n.t("apps.deployFailed", "Deploy failed"), reason);
    } finally {
      set((s) => ({ deployingIds: s.deployingIds.filter((id) => id !== appId) }));
      // Leave `done` visible briefly; footer clears the bar after linger.
      window.setTimeout(() => clearDeployProgress(set, appId), 1200);
    }
  },
  rename: async (appId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const updated = await getBackend().apps.renameApp(appId, trimmed);
      if (updated) mergeRow(set, updated);
    } catch (e) {
      await toastError(
        i18n.t("apps.renameFailed", "Rename failed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  },
  updateAuthMode: async (appId, authMode) => {
    try {
      const updated = await getBackend().apps.updateAppAuthMode(appId, authMode);
      if (!updated) {
        await toastError(
          i18n.t("apps.authModeUpdateFailed", "Could not change the sign-in method"),
          i18n.t("apps.authModeUpdateDenied", "App not found, or you cannot change it"),
        );
        return;
      }
      // `authModePendingRedeploy` is derived server-side from fc_status and the
      // deployed mode, so the row returned by this PATCH already reports the
      // pending state — and keeps reporting it after a reload, on another
      // device, and for a second admin, which a local id list never did.
      mergeRow(set, updated);
    } catch (e) {
      await toastError(
        i18n.t("apps.authModeUpdateFailed", "Could not change the sign-in method"),
        e instanceof Error ? e.message : String(e),
      );
    }
  },
  deleteApp: async (appId) => {
    try {
      const ok = await getBackend().apps.deleteApp(appId);
      if (!ok) {
        await toastError(
          i18n.t("apps.deleteFailed", "Delete failed"),
          i18n.t("apps.deleteDenied", "App not found, or you cannot delete it"),
        );
        return false;
      }
      set((s) => ({
        items: s.items.filter((a) => a.id !== appId),
        selectedAppId: s.selectedAppId === appId ? null : s.selectedAppId,
        deployingIds: s.deployingIds.filter((id) => id !== appId),
      }));
      const { toast } = await import("sonner");
      toast.success(i18n.t("apps.deleted", "App deleted"));
      return true;
    } catch (e) {
      await toastError(
        i18n.t("apps.deleteFailed", "Delete failed"),
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  },
}));
