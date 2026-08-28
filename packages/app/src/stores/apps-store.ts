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
  encodeWorkspaceId,
  getDaemonEnvActivationDiagnostics,
  type SeedAppResult,
} from "@/lib/daemon-local-client";
import { isTauri } from "@/lib/utils";
import type { AppRow, AppAuthMode } from "@/lib/backend/types";

interface AppsState {
  items: AppRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  teamId: string | null;
  /** App ids with a deploy in flight — drives per-row spinner / disabled state. */
  deployingIds: string[];
  /** Last session opened for each app — a hint for re-open, not a 1:1 binding. */
  sessionIdByAppId: Record<string, string>;
  /** Reverse map for control-panel app resolution (session → app). */
  appIdBySessionId: Record<string, string>;
  /** App highlighted in column 1; drives column 2 session list when filter is apps. */
  selectedAppId: string | null;
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
  }) => Promise<AppRow>;
  reseed: (appId: string) => Promise<void>;
  /** Full FC deploy: startDeploy → daemon build+upload → finalize. */
  deploy: (appId: string) => Promise<void>;
  rename: (appId: string, name: string) => Promise<void>;
  updateAuthMode: (appId: string, authMode: AppAuthMode) => Promise<void>;
  deleteApp: (appId: string) => Promise<boolean>;
}

type SetState = StoreApi<AppsState>["setState"];

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

/** Map daemon / cloud errors to short Chinese copy for deploy toasts. */
export function mapDeployErrorReason(raw: string): string {
  const lower = raw.toLowerCase();
  if (raw.includes("uncommitted or unpushed")) {
    return "工作区有未提交或未推送的改动，请先 commit 并 push 后再部署。";
  }
  if (lower.includes("pnpm install timed out")) {
    return "依赖安装超时（10 分钟），请检查网络或 lockfile 后重试。";
  }
  if (lower.includes("pnpm build timed out")) {
    return "构建超时（10 分钟），请检查构建脚本后重试。";
  }
  if (lower.includes("artifact exceeds") || lower.includes("50 mib")) {
    return "构建产物超过 50 MiB 上限，请精简输出后重试。";
  }
  if (lower.includes("presigned") || lower.includes("upload url expired")) {
    return "上传链接已过期，请重新发起部署。";
  }
  if (lower.includes("unsupported_auth_mode") || lower.includes("third-party login")) {
    return "第三方登录尚未支持部署，请切换到平台登录或无登录模式。";
  }
  if (lower.includes("vanity_required") || lower.includes("apps public domain")) {
    return "平台登录需要配置应用公开域名（APPS_PUBLIC_DOMAIN）。";
  }
  if (lower.includes("git commit not found on remote")) {
    return "Gitea 上找不到该 commit，请确认已 push 后再部署。";
  }
  if (lower.includes("lockfile out of sync")) {
    return "pnpm-lock.yaml 与 package.json 不一致，请提交 lockfile 后重试。";
  }
  if (lower.includes("build output missing")) {
    return "构建未产出 .output/ 目录，请检查构建脚本。";
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
    return "本机 amuxd 未连接，无法构建。请确认守护进程在运行后重试。";
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
export function isGiteaManaged(app: Pick<AppRow, "gitAuthKind">): boolean {
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
export async function ensureAppCheckout(app: AppRow): Promise<void> {
  if (!isTauri()) return;
  if (app.provisionStatus !== "ready") return;

  const workdirInfo = await daemonAppWorkdir(app.id, app.teamId);
  if (!workdirInfo) return;
  const workdir = workdirInfo.workdir;
  if (await localWorkdirHasCheckout(workdir)) return;

  let gitRemoteUrl: string | null = app.gitRemoteUrl?.trim() || null;
  let deployKeyPem: string | null = null;

  if (isGiteaManaged(app)) {
    try {
      const cred = await getBackend().apps.getGitCredential(app.id);
      if (!cred?.privateKeyPem || !cred.remoteUrl) return;
      gitRemoteUrl = cred.remoteUrl;
      deployKeyPem = cred.privateKeyPem;
    } catch (e) {
      console.warn("getGitCredential failed during checkout (non-fatal)", e);
      return;
    }
  } else if (!gitRemoteUrl) {
    return;
  }

  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    result = await cloneDaemonApp(app.id, app.teamId, gitRemoteUrl, deployKeyPem);
  } catch (e) {
    console.warn("app clone kick failed (non-fatal)", e);
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
  sessionIdByAppId: {},
  appIdBySessionId: {},
  selectedAppId: null,
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
    // The cloud API only inserts the row; the app's files come from the local
    // daemon, which writes its own embedded template. Non-fatal — a daemon that
    // is down (unreachable) leaves the row `pending` so the user can reseed.
    if (row.provisionStatus === "pending" || row.provisionStatus === "repo_created") {
      await runSeed(set, row);
    }
    // Return the row as it stands AFTER seeding — the caller decides what to do
    // next based on whether the app actually has its files.
    return get().items.find((a) => a.id === row.id) ?? row;
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
          const accepted = publicDeployConfirm.run(ACTIVE_TURN_DEPLOY_CONFIRM_MESSAGE);
          if (!accepted) return;
        }
      }
    }

    if (app.authMode === "none") {
      const accepted = publicDeployConfirm.run(PUBLIC_DEPLOY_CONFIRM_MESSAGE);
      if (!accepted) return;
    }

    set((s) => ({ deployingIds: [...s.deployingIds, appId] }));
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

      let gitRemoteUrl: string | undefined;
      let deployKeyPem: string | undefined;
      if (viaGitea) {
        const cred = await getBackend().apps.getGitCredential(appId);
        if (!cred?.privateKeyPem || !cred.remoteUrl) {
          throw new Error("无法获取 Gitea 部署凭证");
        }
        gitRemoteUrl = cred.remoteUrl;
        deployKeyPem = cred.privateKeyPem;
      }

      const build = await buildDaemonApp(appId, app.teamId, {
        gitCommitSha,
        gitRemoteUrl,
        deployKeyPem,
        presignedPut: started.presignedPut,
      });
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
      const finalized = await getBackend().apps.finalizeDeploy(appId, {
        ...(gitCommitSha ? { gitCommitSha } : {}),
        deployToken: started.deployToken,
      });
      // The merged row carries `authModePendingRedeploy` straight from the
       // server, so a successful finalize clears the warning on its own — there
       // is no local flag left to reset here.
      mergeRow(set, finalized);
    } catch (e) {
      const reason = mapCloudDeployError(e);
      await reportDeployError(set, appId, reason);
      await toastError("部署失败", reason);
    } finally {
      set((s) => ({ deployingIds: s.deployingIds.filter((id) => id !== appId) }));
    }
  },
  rename: async (appId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const updated = await getBackend().apps.renameApp(appId, trimmed);
      if (updated) mergeRow(set, updated);
    } catch (e) {
      await toastError("重命名失败", e instanceof Error ? e.message : String(e));
    }
  },
  updateAuthMode: async (appId, authMode) => {
    try {
      const updated = await getBackend().apps.updateAppAuthMode(appId, authMode);
      if (!updated) {
        await toastError("更新登录方式失败", "应用不存在或无权修改");
        return;
      }
      // `authModePendingRedeploy` is derived server-side from fc_status and the
      // deployed mode, so the row returned by this PATCH already reports the
      // pending state — and keeps reporting it after a reload, on another
      // device, and for a second admin, which a local id list never did.
      mergeRow(set, updated);
    } catch (e) {
      await toastError("更新登录方式失败", e instanceof Error ? e.message : String(e));
    }
  },
  deleteApp: async (appId) => {
    try {
      const ok = await getBackend().apps.deleteApp(appId);
      if (!ok) {
        await toastError("删除失败", "应用不存在或无权删除");
        return false;
      }
      set((s) => ({
        items: s.items.filter((a) => a.id !== appId),
        selectedAppId: s.selectedAppId === appId ? null : s.selectedAppId,
        deployingIds: s.deployingIds.filter((id) => id !== appId),
      }));
      const { toast } = await import("sonner");
      toast.success("应用已删除");
      return true;
    } catch (e) {
      await toastError("删除失败", e instanceof Error ? e.message : String(e));
      return false;
    }
  },
}));
