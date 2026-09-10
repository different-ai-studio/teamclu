import { create, type StoreApi } from "zustand";
import { getBackend } from "@/lib/backend";
import {
  ACTIVE_TURN_DEPLOY_CONFIRM_MESSAGE,
  PUBLIC_DEPLOY_CONFIRM_MESSAGE,
  publicDeployConfirm,
} from "@/lib/apps/app-deploy-confirm";
import {
  seedDaemonApp,
  buildDaemonApp,
  daemonAppManifest,
  cloneDaemonApp,
  daemonAppWorkdir,
  daemonLocalAppIds,
  encodeWorkspaceId,
  getDaemonEnvActivationDiagnostics,
  type BuildAppResult,
  type SeedAppResult,
} from "@/lib/daemon/daemon-local-client";
import { isTauri } from "@/lib/utils";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";
import { useAuthStore } from "@/stores/auth-store";
import i18n from "@/lib/i18n";
import type { AppTypeId } from "@/lib/apps/app-types";
import type {
  AppRow,
  AppAuthPatch,
  AppCustomDomain,
  VerifyAppDomainResult,
} from "@/lib/backend/types";

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
  /**
   * Which (server, user, team) the loaded list actually belongs to, or null
   * when nothing authoritative is cached.
   *
   * Not just `teamId`: the same team id means a different set of apps on a
   * different deployment or under a different account, and switching either
   * one is exactly when a stale "no apps" answer used to stick.
   */
  loadedKey: string | null;
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
    /** The code is a checkout already on this machine WITH a remote of its own:
     *  no repo is provisioned and no template is written. */
    localOnly?: boolean;
    /**
     * Absolute path to a folder the user picked that has no remote to record —
     * not a repo at all, or a repo nobody ever pushed.
     *
     * The app gets a Gitea repo like any other (so it can deploy a commit), but
     * the daemon publishes this directory as it stands instead of writing a
     * starter template over it. Bound before the seed runs, because the seed
     * resolves the app's workdir from that binding.
     */
    adoptLocalDir?: string | null;
  }) => Promise<AppRow>;
  /** Re-ask the daemon which apps are on this machine. */
  refreshLocalApps: (teamId?: string | null) => Promise<void>;
  /** Clone a team app onto this machine (the library dialog's "download"). */
  download: (app: AppRow) => Promise<void>;
  reseed: (appId: string) => Promise<void>;
  /** Full FC deploy: startDeploy → daemon build+upload → finalize. */
  deploy: (appId: string) => Promise<void>;
  rename: (appId: string, name: string) => Promise<void>;
  /**
   * Bumped whenever a management tab changes something the control panel
   * counts.
   *
   * The panel is now nothing but those counts, and they are loaded once per app
   * selection — so creating three cron jobs in the tab the panel opened left the
   * panel still saying "0 个任务" until the user selected another app and came
   * back. The tabs already hold the fresh data; this is the cheapest signal that
   * says "ask again" without wiring each count into the store.
   */
  summaryRevision: number;
  invalidateAppSummary: () => void;
  /**
   * Re-read one app row from the server and merge it.
   *
   * For the server-DERIVED fields a mutation cannot return: `envPendingRedeploy`
   * is computed from two timestamps the env write moved, and the PUT answers
   * with the variable, not the app. Best-effort — a failed refresh must not turn
   * a successful write into an error.
   */
  refreshApp: (appId: string) => Promise<void>;
  /** Who on the team can see this app. True when the change stuck. */
  setVisibility: (appId: string, visibility: "personal" | "team") => Promise<boolean>;
  /** What kind of app this is. Admin only. True when the change stuck. */
  setType: (appId: string, type: AppTypeId) => Promise<boolean>;
  /** Change any part of the login wall in one request. True when it stuck. */
  updateAuthPolicy: (appId: string, patch: AppAuthPatch) => Promise<boolean>;
  /** Bind a domain and get back the DNS records the owner must publish. */
  bindCustomDomain: (appId: string, domain: string) => Promise<AppCustomDomain | null>;
  verifyCustomDomain: (appId: string) => Promise<VerifyAppDomainResult>;
  unbindCustomDomain: (appId: string) => Promise<AppCustomDomain | null>;
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

/**
 * Patch the domain fields of one row from a custom-domain response.
 *
 * Those endpoints answer with the domain's own shape, not an app row, so there
 * is nothing to merge wholesale — and re-fetching the app just to learn two
 * fields we were already told would be a round trip for nothing.
 */
function mergeDomain(set: SetState, appId: string, domain: AppCustomDomain): void {
  set((s) => ({
    items: s.items.map((a) =>
      a.id === appId
        ? { ...a, customDomain: domain.domain, customDomainVerifiedAt: domain.verifiedAt }
        : a,
    ),
  }));
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
  // Deploy publishes uncommitted work now, so this only fires for a daemon
  // older than that change. Kept for exactly that reason.
  if (raw.includes("uncommitted or unpushed")) {
    return i18n.t(
      "apps.deployErrorReason.uncommitted",
      "The workspace has uncommitted or unpushed changes. Commit and push, then deploy.",
    );
  }
  if (raw.includes("no package.json to build")) {
    return i18n.t(
      "apps.deployErrorReason.noPackageJson",
      "This app has no code yet — its folder has no package.json. Ask the agent to build it, or reseed the app.",
    );
  }
  // Distinct from the one above: that app is a node app with nothing in it,
  // this one has nothing a build of either kind could start from.
  if (raw.includes("neither a package.json nor a Dockerfile")) {
    return i18n.t(
      "apps.deployErrorReason.noCode",
      "This app has no code yet — its folder has neither a package.json nor a Dockerfile. Ask the agent to build it, or reseed the app.",
    );
  }
  // Says which file was not found. Windows resolves a bare command name by
  // appending .exe only, so a missing pnpm used to surface as a bare "the
  // system cannot find the file specified" with no clue what file.
  if (raw.includes("pnpm is not installed")) {
    return i18n.t(
      "apps.deployErrorReason.noPnpm",
      "pnpm was not found on this machine, and this app is built with it. Install pnpm (npm i -g pnpm), then retry.",
    );
  }
  if (raw.includes("origin has commits this checkout does not")) {
    return i18n.t(
      "apps.deployErrorReason.pushRejected",
      "The repo has commits this machine does not. Pull and resolve them, then deploy again.",
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
 * Explain a seed failure the raw daemon text does not.
 *
 * A clone that ran out of time is the one failure whose cause is invisible:
 * git was not asked anything and printed nothing, because it is the machine's
 * credential helper that is waiting — often on a window that has nowhere to
 * appear. Everything else git says is already the answer.
 */
function mapSeedErrorReason(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (raw.includes("git clone timed out")) {
    return i18n.t(
      "apps.seedErrorReason.cloneTimeout",
      "克隆超时。多半是这台机器的 git 凭证助手在等一个弹不出来的登录框；先在终端里 clone 一次这个仓库，再回来重试。",
    );
  }
  return raw;
}

/**
 * Drop a cloud app row that was created only so a clone could run, and that
 * clone then failed. Silent: the user is about to see the clone error on the
 * form, not a "App deleted" success toast.
 */
async function discardCreatedApp(set: SetState, appId: string): Promise<void> {
  try {
    await getBackend().apps.deleteApp(appId);
  } catch (e) {
    console.warn("discard created app failed", e);
  }
  set((s) => ({
    items: s.items.filter((a) => a.id !== appId),
    selectedAppId: s.selectedAppId === appId ? null : s.selectedAppId,
  }));
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
 * Returns the seed outcome so callers can decide what to surface. A remote
 * import that fails on create is rolled back by `create` (delete the empty
 * cloud row + throw); a reseed leaves the row at `error` and toasts.
 *
 * @param cloneUrl the address to clone from, when it differs from the stored
 * one. Credentials pasted into a repo URL are stripped before the row is
 * written, so the create path passes what the user actually typed — that copy
 * lives for the length of one call and is never persisted.
 */
async function runSeed(
  set: SetState,
  app: AppRow,
  adoptExisting = false,
  cloneUrl?: string | null,
): Promise<SeedAppResult> {
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
        return { outcome: "failed", workdir: null, error: "无法获取 Gitea 部署密钥" };
      }
    } catch (e) {
      console.warn("getGitCredential failed (non-fatal)", e);
      await patchStatus(set, app.id, "error");
      return {
        outcome: "failed",
        workdir: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    result = await seedDaemonApp(
      app.id,
      app.teamId,
      app.name,
      app.type,
      cloneUrl?.trim() || app.gitRemoteUrl,
      deployKeyPem,
      adoptExisting,
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
      const { bindAppWorkdir } = await import("@/lib/apps/app-session");
      await bindAppWorkdir(app, result.workdir);
    }
    await patchStatus(set, app.id, "ready");
  } else if (result.outcome === "failed") {
    await patchStatus(set, app.id, "error");
  }
  // unreachable → no status change; reseed remains available.
  return result;
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
    const { bindAppWorkdir } = await import("@/lib/apps/app-session");
    await bindAppWorkdir(app, result.workdir);
  } else if (result.outcome === "failed") {
    await toastError("仓库克隆失败", result.error ?? undefined);
  }
}

/**
 * What a cached app list is valid for: this deployment, this account, this
 * team. Any of the three changing makes the cached answer someone else's.
 */
function appsCacheKey(teamId: string): string {
  const server = getEffectiveServerConfigSync().cloudApiUrl;
  const user = useAuthStore.getState().session?.user?.id ?? "";
  return `${server}|${user}|${teamId}`;
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
  loadedKey: null,
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
    const key = appsCacheKey(teamId);
    const s = get();
    if (s.loadedKey === key && !opts?.force) return;
    set({ loading: true, error: null, teamId });
    try {
      const items = await getBackend().apps.listApps(teamId);
      set({
        items,
        loaded: true,
        loading: false,
        // An empty answer is never cached. RLS does not fail a request it
        // cannot satisfy — it filters it to nothing — so a list fetched a
        // moment before the session or the server finished switching comes
        // back as `[]` with a 200, and caching that told the user their apps
        // were gone until they restarted the app. Re-asking costs one request
        // on a team that genuinely has none.
        loadedKey: items.length > 0 ? key : null,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "failed to load apps",
      });
    }
  },
  create: async (input) => {
    const { adoptLocalDir, ...createInput } = input;
    const row = await getBackend().apps.createApp(createInput);
    set((s) => ({ items: [row, ...s.items] }));
    // Point the daemon at the user's folder BEFORE seeding. The seed resolves
    // the app's workdir from this override, so binding afterwards would have
    // it publish an empty default directory and leave the folder the user
    // actually picked unattached.
    if (adoptLocalDir?.trim()) {
      try {
        const { bindDaemonAppWorkdir } = await import("@/lib/daemon/daemon-local-client");
        await bindDaemonAppWorkdir(row.id, input.teamId, adoptLocalDir.trim());
      } catch (e) {
        await patchStatus(set, row.id, "error");
        await toastError(
          "无法使用这个目录",
          e instanceof Error ? e.message : String(e),
        );
        return get().items.find((a) => a.id === row.id) ?? row;
      }
    }
    // A local checkout is already on disk and comes back `ready`; seeding it
    // would write the starter template over the user's own files. The guard is
    // the status rather than the flag so an app that somehow arrives `ready` by
    // another route is treated the same way.
    let seedResult: SeedAppResult | null = null;
    if (row.provisionStatus === "pending" || row.provisionStatus === "repo_created") {
      // The cloud API only inserts the row; the app's files come from the local
      // daemon, which writes its own embedded template. Non-fatal when the
      // daemon is unreachable — the row stays `pending` so the user can reseed.
      //
      // The typed address, not the stored one: `POST /v1/apps` strips any
      // credential out of it before writing the row, and this is the one call
      // that still needs it.
      seedResult = await runSeed(set, row, !!adoptLocalDir?.trim(), input.gitRemoteUrl);
    }
    // Remote import whose clone failed: the cloud row is an empty shell. Leaving
    // it looks like create succeeded while a toast says it failed. Roll it back
    // and throw so CreateAppView keeps the form open with the reason.
    if (input.gitRemoteUrl?.trim() && seedResult?.outcome === "failed") {
      await discardCreatedApp(set, row.id);
      throw new Error(
        mapSeedErrorReason(seedResult.error) ??
          i18n.t("apps.cloneFailed", "仓库克隆失败"),
      );
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
    const result = await runSeed(set, app);
    // Reseed keeps the row: the user already owns this app and can retry. Toast
    // only when a remote clone is what failed — template seed failures stay
    // quiet (status is already `error`).
    if (result.outcome === "failed" && app.gitRemoteUrl) {
      await toastError("仓库克隆失败", mapSeedErrorReason(result.error));
    }
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

      // What the checkout declares, read before the deploy is minted: a
      // container app is handed a registry to push to and everything else a
      // presigned URL to upload to, and only the machine holding the checkout
      // can say which this is.
      const declared = await daemonAppManifest(appId, app.teamId);
      const started = await getBackend().apps.deployApp(appId, {
        ...(gitCommitSha ? { gitCommitSha } : {}),
        ...(declared?.runtime ? { runtime: declared.runtime } : {}),
      });
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
          // Exactly one of these is set — see the control plane's startDeploy.
          presignedPut: started.presignedPut,
          image: started.image,
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
      // What the daemon built, not what we asked for. A deploy publishes work
      // the agent left uncommitted, and HEAD then sits past the sha read off
      // Gitea before any of this started; recording that one would name a
      // commit the running function was not built from.
      const builtSha = build.gitCommitSha ?? gitCommitSha;
      const finalized = await getBackend().apps.finalizeDeploy(appId, {
        ...(builtSha ? { gitCommitSha: builtSha } : {}),
        // How the app says it starts. The control plane used to assume one
        // answer for every app; this is the app's own, read off its
        // declaration by the daemon that just built it.
        ...(build.runtime ? { runtime: build.runtime } : {}),
        // The image that build actually pushed. A container app has no code
        // object, so finalizing without it would point the function at whatever
        // the previous deploy left in OSS.
        ...(build.image ? { image: build.image } : {}),
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
  summaryRevision: 0,
  invalidateAppSummary: () => set((s) => ({ summaryRevision: s.summaryRevision + 1 })),
  refreshApp: async (appId) => {
    try {
      const row = await getBackend().apps.getApp(appId);
      if (row) mergeRow(set, row);
    } catch (e) {
      console.warn("app row refresh failed (non-fatal)", e);
    }
  },
  setVisibility: async (appId, visibility) => {
    try {
      const updated = await getBackend().apps.setAppVisibility(appId, visibility);
      if (!updated) {
        // Creator-only, and the server cannot say so without leaking whether
        // the app exists — so the client names the rule instead of relaying a
        // bare 404 the user has no way to interpret.
        await toastError(
          i18n.t("apps.visibilityFailed", "Could not change who can see this app"),
          i18n.t("apps.visibilityDenied", "只有创建这个应用的人可以改可见性。"),
        );
        return false;
      }
      mergeRow(set, updated);
      return true;
    } catch (e) {
      await toastError(
        i18n.t("apps.visibilityFailed", "Could not change who can see this app"),
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  },
  setType: async (appId, type) => {
    try {
      const updated = await getBackend().apps.setAppType(appId, type);
      if (!updated) {
        // Same shape as visibility: admin only, and the 404 cannot say so
        // without confirming the app exists, so the rule is named here.
        await toastError(
          i18n.t("apps.typeFailed", "Could not change the app type"),
          i18n.t("apps.typeDenied", "Only people with admin access to this app can change its type."),
        );
        return false;
      }
      // The row carries `typePendingRedeploy` from the server, so the "takes
      // effect on the next deploy" line follows it with no local flag.
      mergeRow(set, updated);
      // The panel's counts are loaded once per app and the data row is one of
      // them: leaving data_app has the data browser answer "no database" from
      // this moment, and the panel would otherwise keep saying "3 张表".
      get().invalidateAppSummary();
      return true;
    } catch (e) {
      await toastError(
        i18n.t("apps.typeFailed", "Could not change the app type"),
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  },
  updateAuthPolicy: async (appId, patch) => {
    try {
      const updated = await getBackend().apps.updateAppAuth(appId, patch);
      if (!updated) {
        await toastError(
          i18n.t("apps.authModeUpdateFailed", "Could not change the sign-in settings"),
          i18n.t("apps.authModeUpdateDenied", "App not found, or you cannot change it"),
        );
        return false;
      }
      // `authModePendingRedeploy` is derived server-side from fc_status and the
      // deployed mode, so the row returned by this PATCH already reports the
      // pending state — and keeps reporting it after a reload, on another
      // device, and for a second admin, which a local id list never did.
      mergeRow(set, updated);
      return true;
    } catch (e) {
      // The server validates scope and rules as a pair, so its message names
      // the actual problem ("paths needs at least one required rule", "* is not
      // supported"). Passing it through beats a generic failure.
      await toastError(
        i18n.t("apps.authModeUpdateFailed", "Could not change the sign-in settings"),
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  },
  bindCustomDomain: async (appId, domain) => {
    try {
      const out = await getBackend().apps.setAppCustomDomain(appId, domain);
      if (!out) {
        await toastError(
          i18n.t("apps.domainBindFailed", "Could not bind the domain"),
          i18n.t("apps.domainBindDenied", "App not found, or you cannot change it"),
        );
        return null;
      }
      mergeDomain(set, appId, out);
      return out;
    } catch (e) {
      await toastError(
        i18n.t("apps.domainBindFailed", "Could not bind the domain"),
        e instanceof Error ? e.message : String(e),
      );
      return null;
    }
  },
  verifyCustomDomain: async (appId) => {
    try {
      const result = await getBackend().apps.verifyAppCustomDomain(appId);
      // Only a success changes the row; `pending` is the caller's to display,
      // and refreshing on it would just re-read the same unverified state.
      if (result.status === "verified") mergeDomain(set, appId, result.domain);
      return result;
    } catch (e) {
      await toastError(
        i18n.t("apps.domainVerifyFailed", "Could not check the domain"),
        e instanceof Error ? e.message : String(e),
      );
      return { status: "not_found" };
    }
  },
  unbindCustomDomain: async (appId) => {
    try {
      const out = await getBackend().apps.deleteAppCustomDomain(appId);
      if (out) mergeDomain(set, appId, out);
      return out;
    } catch (e) {
      await toastError(
        i18n.t("apps.domainUnbindFailed", "Could not unbind the domain"),
        e instanceof Error ? e.message : String(e),
      );
      return null;
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
