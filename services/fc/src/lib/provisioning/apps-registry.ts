type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

/**
 * The image registry a container app is deployed through.
 *
 * Deliberately not Alibaba Container Registry: ACR's personal edition can no
 * longer be created, and its enterprise edition is a per-instance bill for
 * something a deployment that already runs a proxy and an object store can
 * serve itself. What is left is the generic shape every registry has — a host,
 * a namespace, and a login — which Function Compute takes as
 * `customContainerConfig.registryConfig.authConfig`.
 */
export interface AppsRegistryConfig {
  /** Host the daemon pushes to, e.g. `registry.example.com`. */
  host: string;
  /**
   * Host the function pulls from. Defaults to the push host; set it only when
   * the function reaches the registry by a different name (an internal or VPC
   * address).
   */
  pullHost: string;
  /** Path prefix every app's repository sits under. */
  namespace: string;
  /** Login handed to the machine doing the build. Can write. */
  push: RegistryCredentials;
  /**
   * Login baked into the deployed function. Read-only where the registry can
   * express that; falls back to the push login, which is why the fallback is
   * worth avoiding — see `resolveAppsRegistry`.
   */
  pull: RegistryCredentials;
}

export interface RegistryCredentials {
  username: string;
  password: string;
}

export type AppsRegistryResolution =
  | { config: AppsRegistryConfig; error?: undefined }
  | { config?: undefined; error: string };

/**
 * Resolve the registry config, or explain what is missing.
 *
 * The error is a sentence naming a variable, matching `resolveAppsOss`: it
 * reaches the user as the reason their deploy did not start, and "not
 * configured" costs an SSH session to turn into an action.
 */
export function resolveAppsRegistry(env: Env = process.env): AppsRegistryResolution {
  const host = trimmed(env.APPS_REGISTRY_HOST);
  if (!host) {
    return {
      error:
        "APPS_REGISTRY_HOST is not set — a container app's image needs a registry to push to",
    };
  }
  const username = trimmed(env.APPS_REGISTRY_USERNAME);
  const password = trimmed(env.APPS_REGISTRY_PASSWORD);
  if (!username || !password) {
    return {
      error:
        "APPS_REGISTRY_HOST is set but APPS_REGISTRY_USERNAME / APPS_REGISTRY_PASSWORD are empty",
    };
  }
  const push = { username, password };
  // A separate read-only login means the credential baked into the deployed
  // function cannot overwrite the image it runs. Without one the function
  // carries a push credential, and anyone who can read a function's config can
  // replace what every instance of that app executes.
  const pullUsername = trimmed(env.APPS_REGISTRY_PULL_USERNAME);
  const pullPassword = trimmed(env.APPS_REGISTRY_PULL_PASSWORD);
  const pull =
    pullUsername && pullPassword ? { username: pullUsername, password: pullPassword } : push;
  return {
    config: {
      host,
      pullHost: trimmed(env.APPS_REGISTRY_PULL_HOST) || host,
      namespace: trimmed(env.APPS_REGISTRY_NAMESPACE) || "apps",
      push,
      pull,
    },
  };
}

/** The repository one app pushes to. Named for the function, so a person
 *  looking at either console sees the same app twice rather than two things. */
export function appImageRepository(appId: string): string {
  return `tc-app-${appId}`;
}

/** Full image reference: what the daemon pushes and what the function pulls. */
export function appImageReference(
  cfg: AppsRegistryConfig,
  appId: string,
  tag: string,
  host = cfg.host,
): string {
  return `${host}/${cfg.namespace}/${appImageRepository(appId)}:${tag}`;
}

/**
 * Whether an image reference names the repository this app pushes to.
 *
 * The finalize call carries the image the build says it pushed, and that value
 * is what the function is pointed at — so unchecked, a client could finalize
 * one app's deploy onto any image its registry can reach, including another
 * app's. Nothing about the deploy token prevents it: the token proves who
 * started *this* app's deploy, not what the image is.
 *
 * The tag is deliberately not checked. The build corrects it when it publishes
 * work the control plane did not know about (the daemon's `image_tagged_with`),
 * so pinning a tag here would refuse the correct answer; the repository is the
 * part that must not move. A digest reference is accepted the same way.
 *
 * Both hosts count: the daemon reports what it pushed, which is the push host,
 * but a client that normalised to the pull host has still named the same image.
 */
export function imageBelongsToApp(
  cfg: AppsRegistryConfig,
  appId: string,
  image: string,
): boolean {
  const repo = imageRepositoryOf(image.trim());
  const path = `/${cfg.namespace}/${appImageRepository(appId)}`;
  return repo === `${cfg.host}${path}` || repo === `${cfg.pullHost}${path}`;
}

/** Everything before the tag or digest, whichever a reference carries. */
function imageRepositoryOf(image: string): string {
  const at = image.indexOf("@");
  const ref = at < 0 ? image : image.slice(0, at);
  // A registry host may carry a port, so only a `:` after the last `/`
  // separates a tag — in `localhost:5000/apps/a` that colon is the port.
  const colon = ref.indexOf(":", ref.lastIndexOf("/") + 1);
  return colon < 0 ? ref : ref.slice(0, colon);
}

/**
 * The image tag for one deploy.
 *
 * The commit is the tag when there is one, so an image can be traced back to
 * the code in it and a redeploy of an unchanged commit reuses the same layer.
 * An imported app deploying its working directory has no commit of ours, so it
 * falls back to the time — unique, and the only fact available.
 */
export function appImageTag(gitCommitSha: string | null | undefined, now = new Date()): string {
  const sha = (gitCommitSha ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;
  return `d${Math.floor(now.getTime() / 1000)}`;
}

/**
 * The same image, addressed by the host the function can reach.
 *
 * A deployment whose registry answers on one name from a developer's machine
 * and another from inside the network pushes to the first and pulls from the
 * second; the reference recorded by the deploy is the one it pushed. Only the
 * leading segment is touched, and only when it looks like a host — `library/
 * nginx` names no registry at all.
 */
export function imageForPull(image: string, pullHost: string | undefined): string {
  const host = (pullHost ?? "").trim();
  if (!host) return image;
  const slash = image.indexOf("/");
  if (slash < 0) return image;
  const current = image.slice(0, slash);
  if (current === host || !/[.:]/.test(current)) return image;
  return `${host}${image.slice(slash)}`;
}
