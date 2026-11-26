import { create, type StoreApi } from "zustand";
import { useAppTouchStore } from "@/lib/apps/app-recency";
import { getBackend } from "@/lib/backend";
import {
  seedDaemonApp,
  cloneDaemonApp,
  daemonAppWorkdir,
  daemonLocalAppIds,
  type DaemonGitHttpsCredential,
  type SeedAppResult,
} from "@/lib/daemon/daemon-local-client";
import { isTauri } from "@/lib/utils";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";
import { useAuthStore } from "@/stores/auth-store";
import i18n from "@/lib/i18n";
import { usesStoredHttpsCredential } from "@/lib/apps/app-list-helpers";
import { keepRelationship } from "@/lib/apps/app-relationship";
import type { AppTypeId } from "@/lib/apps/app-types";
import { reportAppProvisionFailure, type AppProvisionStage } from "@/lib/telemetry/app-provision-report";
import type {
  AppRow,
  AppAuthPatch,
  AppCustomDomain,
  AppGitCredential,
  AppGitDeployKeyCredential,
  AppGitHttpsCredentialInput,
  VerifyAppDomainResult,
} from "@/lib/backend/types";

interface AppsState {
  items: AppRow[];
  syncApp: (app: AppRow) => void;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  teamId: string | null;
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
    /** The login for a private http(s) `gitRemoteUrl`. Stored on the app
     *  before the clone runs, so teammates can download it too. */
    gitCredential?: AppGitHttpsCredentialInput | null;
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
    /** Agents to grant `write` on the new app (they get nothing by default). */
    grantActorIds?: string[];
  }) => Promise<AppRow>;
  /** Re-ask the daemon which apps are on this machine. */
  refreshLocalApps: (teamId?: string | null) => Promise<void>;
  /** Clone a team app onto this machine (the library dialog's "download"). */
  download: (app: AppRow) => Promise<void>;
  reseed: (appId: string) => Promise<void>;
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
  /**
   * Store the token git uses for this app's imported http(s) repo. Admin only.
   * True when it stuck; a failure has already been toasted.
   */
  saveGitCredential: (appId: string, input: AppGitHttpsCredentialInput) => Promise<boolean>;
  /** Forget that token. Admin only. True when it stuck. */
  clearGitCredential: (appId: string) => Promise<boolean>;
  /** Change any part of the login wall in one request. True when it stuck. */
  updateAuthPolicy: (appId: string, patch: AppAuthPatch) => Promise<boolean>;
  /** Bind a domain and get back the DNS records the owner must publish. */
  bindCustomDomain: (appId: string, domain: string) => Promise<AppCustomDomain | null>;
  verifyCustomDomain: (appId: string) => Promise<VerifyAppDomainResult>;
  unbindCustomDomain: (appId: string) => Promise<AppCustomDomain | null>;
  undeployApp: (appId: string) => Promise<boolean>;
  deleteApp: (appId: string) => Promise<boolean>;
}

type SetState = StoreApi<AppsState>["setState"];

/** Merge a fresh app row (from create/deploy/rename responses) into the store. */
function mergeRow(set: SetState, row: AppRow): void {
  set((s) => ({ items: s.items.map((a) => (a.id === row.id ? keepRelationship(a, row) : a)) }));
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
async function patchStatus(
  set: SetState,
  appId: string,
  status: string,
  reason?: string | null,
): Promise<void> {
  try {
    const updated = await getBackend().apps.updateAppProvisionStatus(appId, status, reason);
    if (updated) set((s) => ({ items: s.items.map((a) => (a.id === appId ? keepRelationship(a, updated) : a)) }));
  } catch (e) {
    console.warn("app status writeback failed (non-fatal)", e);
  }
}

/**
 * A provisioning step on this machine failed: tell Sentry, then write `error`
 * with the reason. Both halves exist because the failure happens where nothing
 * server-side can see it — before this the row said `error` and nothing else.
 */
async function failProvision(
  set: SetState,
  app: Pick<AppRow, "id" | "teamId" | "type">,
  stage: AppProvisionStage,
  reason: string | null | undefined,
): Promise<void> {
  reportAppProvisionFailure(stage, reason, { appId: app.id, teamId: app.teamId, appType: app.type });
  await patchStatus(set, app.id, "error", reason);
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
  // amuxd's ERR_NO_LOCAL_CHECKOUT: the app was seeded on another machine.
  if (raw.includes("app checkout not found on this machine")) {
    return i18n.t(
      "apps.deployErrorReason.noLocalCheckout",
      "This app's code is not on this computer. Deploy from the computer that holds its checkout, or bring the app onto this one first.",
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
  // git's words for a forge that wanted a login nobody supplied. Accurate, but
  // "terminal prompts disabled" reads as a machine fault rather than as "this
  // repo is private".
  if (/could not read (Username|Password)|terminal prompts disabled/i.test(raw)) {
    return i18n.t(
      "apps.seedErrorReason.authRequired",
      "这个仓库需要登录。填上用户名和访问令牌（Personal Access Token）再试。",
    );
  }
  // A forge answers 404 both for a repository that is gone and for a private
  // one the caller has no token for — GitHub deliberately will not say which,
  // so neither can we. What we can do is name both, because the repairs differ
  // (fix the address vs. store a token) and only the user knows which applies.
  const notFound = /repository '([^']+)' not found|Repository not found/i.exec(raw);
  if (notFound) {
    // git prints the address with a trailing slash it added itself; the user is
    // looking for the one they typed.
    const url = notFound[1]?.replace(/\/+$/, "");
    return url
      ? i18n.t(
          "apps.seedErrorReason.repoNotFound",
          "打不开 {{url}}。仓库可能不存在或已改名；也可能是私有仓库，而这台机器没有它的凭证 —— 私有仓库对没有权限的人也答「not found」。核对地址，或在应用设置里存一个访问令牌。",
          { url },
        )
      : i18n.t(
          "apps.seedErrorReason.repoNotFoundNoUrl",
          "仓库地址打不开。它可能不存在或已改名；也可能是私有仓库，而这台机器没有它的凭证 —— 私有仓库对没有权限的人也答「not found」。核对地址，或在应用设置里存一个访问令牌。",
        );
  }
  if (/Authentication failed|Invalid username or password|HTTP Basic: Access denied|returned error: 403/i.test(raw)) {
    return i18n.t(
      "apps.seedErrorReason.authRejected",
      "仓库拒绝了这个凭证。检查访问令牌有没有过期、有没有读取这个仓库的权限。",
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
 * @param httpsCredential the token for an http(s) import when the caller
 * already holds it — the create form, which stored it a moment ago. Without
 * it, an app with a stored token has the token read back here.
 */
async function runSeed(
  set: SetState,
  app: AppRow,
  adoptExisting = false,
  cloneUrl?: string | null,
  httpsCredential?: DaemonGitHttpsCredential | null,
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
      const key = deployKeyOf(await getBackend().apps.getGitCredential(app.id));
      deployKeyPem = key?.privateKeyPem ?? null;
      deployKeyId = key?.deployKeyId ?? null;
      if (!deployKeyPem) {
        const error = "无法获取 Gitea 部署密钥";
        await failProvision(set, app, "deploy_key", error);
        return { outcome: "failed", workdir: null, error };
      }
    } catch (e) {
      console.warn("getGitCredential failed (non-fatal)", e);
      const error = e instanceof Error ? e.message : String(e);
      await failProvision(set, app, "deploy_key", error);
      return { outcome: "failed", workdir: null, error };
    }
  }
  const cloneCredential =
    httpsCredential ?? (needsGiteaPush ? null : await readStoredHttpsCredential(app));

  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    const cloneFrom = cloneUrl?.trim() || app.gitRemoteUrl;
    const httpUrl = accountGitUrl(app);
    result = cloneCredential
      ? await seedDaemonApp(
          app.id,
          app.teamId,
          app.name,
          app.type,
          cloneFrom,
          deployKeyPem,
          adoptExisting,
          cloneCredential,
        )
      : httpUrl
        ? // Per-account git: no http(s) import credential, then the HTTPS
          // address the checkout's people and agents should push to.
          await seedDaemonApp(
            app.id,
            app.teamId,
            app.name,
            app.type,
            cloneFrom,
            deployKeyPem,
            adoptExisting,
            null,
            httpUrl,
          )
        : await seedDaemonApp(
            app.id,
            app.teamId,
            app.name,
            app.type,
            cloneFrom,
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
    await failProvision(set, app, "seed", result.error);
  }
  // unreachable → no status change; reseed remains available.
  return result;
}

/** The deploy-key half of a credential reply, or null for any other kind. */
/** The HTTPS address a per-account app's checkout should use, or null to stay on SSH. */
function accountGitUrl(app: AppRow): string | null {
  return app.gitAccountAuth && app.gitHttpUrl?.trim() ? app.gitHttpUrl.trim() : null;
}

function deployKeyOf(cred: AppGitCredential | null): AppGitDeployKeyCredential | null {
  return cred?.authKind === "deploy_key" ? cred : null;
}

/**
 * The token stored for an imported http(s) repo, or null. Never throws: a
 * clone without it still runs, and a private repo then fails with git's own
 * reason, which `mapSeedErrorReason` turns into "this repo needs a login".
 */
async function readStoredHttpsCredential(app: AppRow): Promise<DaemonGitHttpsCredential | null> {
  if (!usesStoredHttpsCredential(app)) return null;
  try {
    const cred = await getBackend().apps.getGitCredential(app.id);
    return cred?.authKind === "https_token" ? { username: cred.username, token: cred.token } : null;
  } catch (e) {
    console.warn("reading the stored git credential failed (non-fatal)", e);
    return null;
  }
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
 * local checkout yet, fetch the repo and bind the workdir. Anyone who can see
 * the app can do this — the server hands a read-only deploy key to those who
 * may not push. Skips when the directory already has files; dirty trees are
 * left alone (deploy/build reuse ERR_DIRTY — we never clone over them).
 *
 * Resolves to the checkout directory when this machine has one afterwards, so
 * a caller that needs the path next does not ask the daemon for it again; null
 * otherwise.
 */
export async function ensureAppCheckout(
  app: AppRow,
  opts: { surfaceErrors?: boolean } = {},
): Promise<string | null> {
  // Every early return below is silent on the automatic path — it fires on
  // selection, where a toast about a daemon that is still starting would be
  // noise. A download the user clicked is the opposite: saying nothing looks
  // like a dead button, so `surfaceErrors` turns each one into a reason.
  const { surfaceErrors = false } = opts;
  const bail = async (reason: string) => {
    if (surfaceErrors) await toastError("下载失败", reason);
  };

  if (!isTauri()) return null;
  // For a hosted repo anything short of `ready` means the seed never pushed,
  // and a clone would fetch an empty repository. An imported repo is not ours
  // to be unready: its status only says whether the creator's own clone
  // worked, and the repository is there to fetch either way.
  const importedWithRemote = !isGiteaManaged(app) && !!app.gitRemoteUrl?.trim();
  if (app.provisionStatus !== "ready" && !importedWithRemote) {
    await bail("应用尚未就绪");
    return null;
  }

  const workdirInfo = await daemonAppWorkdir(app.id, app.teamId);
  if (!workdirInfo) {
    await bail(mapDeployErrorReason("amuxd daemon is not connected"));
    return null;
  }
  const workdir = workdirInfo.workdir;
  if (await localWorkdirHasCheckout(workdir)) return workdir;

  let gitRemoteUrl: string | null = app.gitRemoteUrl?.trim() || null;
  let deployKeyPem: string | null = null;
  let deployKeyId: number | null = null;
  let httpsCredential: DaemonGitHttpsCredential | null = null;

  if (isGiteaManaged(app)) {
    try {
      const key = deployKeyOf(await getBackend().apps.getGitCredential(app.id));
      if (!key?.privateKeyPem || !key.remoteUrl) {
        await bail("没有这个应用仓库的访问权限");
        return null;
      }
      gitRemoteUrl = key.remoteUrl;
      deployKeyPem = key.privateKeyPem;
      deployKeyId = key.deployKeyId ?? null;
    } catch (e) {
      console.warn("getGitCredential failed during checkout (non-fatal)", e);
      await bail(e instanceof Error ? e.message : String(e));
      return null;
    }
  } else if (!gitRemoteUrl) {
    // An app with no remote of any kind has nothing to fetch — its code only
    // ever existed on the machine that made it.
    await bail("这个应用没有可下载的仓库地址");
    return null;
  } else {
    // A private import is the case this exists for: the machine that created
    // the app had a login for the repo, and this one has only what is stored.
    httpsCredential = await readStoredHttpsCredential(app);
  }

  let result: SeedAppResult = { outcome: "unreachable", workdir: null, error: null };
  try {
    result = httpsCredential
      ? await cloneDaemonApp(app.id, app.teamId, gitRemoteUrl, deployKeyPem, httpsCredential)
      : accountGitUrl(app)
        ? await cloneDaemonApp(app.id, app.teamId, gitRemoteUrl, deployKeyPem, null, accountGitUrl(app))
        : await cloneDaemonApp(app.id, app.teamId, gitRemoteUrl, deployKeyPem);
  } catch (e) {
    console.warn("app clone kick failed (non-fatal)", e);
  } finally {
    await returnGitCredential(app.id, deployKeyId);
  }

  if (result.outcome === "seeded" && result.workdir) {
    const { bindAppWorkdir } = await import("@/lib/apps/app-session");
    await bindAppWorkdir(app, result.workdir);
    // An import whose first clone failed on the machine that created it now
    // has its code on this one, which is what `ready` means. The server lets
    // only an admin write it; for anyone else this is a no-op and the download
    // still stands.
    if (app.provisionStatus !== "ready") {
      await patchStatus(useAppsStore.setState, app.id, "ready");
    }
    return result.workdir;
  }
  if (result.outcome === "failed") {
    await toastError("仓库克隆失败", mapSeedErrorReason(result.error));
  }
  return null;
}

/**
 * Why a stored-credential write failed, in words the user can act on. A 404 is
 * also what a caller without admin gets — the route will not say which, and
 * from a settings page "not an admin" is by far the likelier.
 */
function gitCredentialErrorReason(e: unknown): string {
  if (e && typeof e === "object" && "status" in e && (e as { status: unknown }).status === 404) {
    return i18n.t("apps.gitCredential.denied", "只有应用管理员可以修改仓库凭证。");
  }
  return e instanceof Error ? e.message : String(e);
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
  syncApp: (app) => set((state) => ({ items: state.items.map((row) => row.id === app.id ? { ...row, ...app } : row) })),
  loaded: false,
  loading: false,
  error: null,
  teamId: null,
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
    // Opening an app is using it: it moves to the top of the sidebar's 本机.
    if (appId) useAppTouchStore.getState().touch(appId);
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
    const { adoptLocalDir, gitCredential, ...createInput } = input;
    const row = await getBackend().apps.createApp(createInput);
    // Whoever creates an app owns it; the create response does not say so.
    set((s) => ({ items: [{ ...row, relationship: row.relationship ?? "owner", invitedByActorId: null }, ...s.items] }));
    // Stored before the clone, not after it. The clone is the first thing that
    // needs the token, and every teammate's later download reads this copy — an
    // app whose token could not be stored clones here and nowhere else, so that
    // fails the create the same way a failed clone does.
    const cloneCredential = gitCredential?.token.trim() ? gitCredential : null;
    if (cloneCredential) {
      try {
        mergeRow(set, await getBackend().apps.setGitHttpsCredential(row.id, cloneCredential));
      } catch (e) {
        await discardCreatedApp(set, row.id);
        throw new Error(
          `${i18n.t("apps.gitCredential.saveFailed", "凭证保存失败")}：${gitCredentialErrorReason(e)}`,
          { cause: e },
        );
      }
    }
    // Point the daemon at the user's folder BEFORE seeding. The seed resolves
    // the app's workdir from this override, so binding afterwards would have
    // it publish an empty default directory and leave the folder the user
    // actually picked unattached.
    if (adoptLocalDir?.trim()) {
      try {
        const { bindDaemonAppWorkdir } = await import("@/lib/daemon/daemon-local-client");
        await bindDaemonAppWorkdir(row.id, input.teamId, adoptLocalDir.trim());
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await failProvision(set, row, "adopt_dir", reason);
        await toastError("无法使用这个目录", reason);
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
      seedResult = await runSeed(
        set,
        row,
        !!adoptLocalDir?.trim(),
        input.gitRemoteUrl,
        cloneCredential,
      );
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
    // Just downloaded is just used — it lands at the top of 本机, not wherever
    // its last session happened to fall.
    if (get().localAppIds?.includes(app.id)) useAppTouchStore.getState().touch(app.id);
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
  saveGitCredential: async (appId, input) => {
    try {
      mergeRow(set, await getBackend().apps.setGitHttpsCredential(appId, input));
      return true;
    } catch (e) {
      await toastError(
        i18n.t("apps.gitCredential.saveFailed", "凭证保存失败"),
        gitCredentialErrorReason(e),
      );
      return false;
    }
  },
  clearGitCredential: async (appId) => {
    try {
      const updated = await getBackend().apps.clearGitHttpsCredential(appId);
      if (!updated) {
        await toastError(
          i18n.t("apps.gitCredential.clearFailed", "凭证清除失败"),
          i18n.t("apps.gitCredential.denied", "只有应用管理员可以修改仓库凭证。"),
        );
        return false;
      }
      mergeRow(set, updated);
      return true;
    } catch (e) {
      await toastError(
        i18n.t("apps.gitCredential.clearFailed", "凭证清除失败"),
        gitCredentialErrorReason(e),
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
  undeployApp: async (appId) => {
    try {
      const result = await getBackend().apps.undeployApp(appId);
      mergeRow(set, result.app);
      return true; // Accepted; status polling, not this return value, proves completion.
    } catch (e) {
      await toastError(i18n.t('apps.undeploy.failed', '卸载部署失败'), e instanceof Error ? e.message : String(e));
      return false;
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
