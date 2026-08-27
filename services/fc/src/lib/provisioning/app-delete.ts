import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { AuthMode } from "./app-auth-mode.js";
import { OAUTH_CLIENT_SECRET_KIND } from "./app-secrets.js";
import { appFunctionName, appOssObjectName } from "./app-deploy.js";
import type { GotrueOAuthClient } from "./gotrue-oauth.js";
import { GITEA_AUTH_KIND, type GiteaClient } from "./gitea.js";
import { revokeAllDeployKeys } from "./deploy-key.js";

export type TeardownAppDeps = {
  fcOps?: {
    deleteHttpTrigger?: (functionName: string) => Promise<void>;
    deleteFunction: (functionName: string) => Promise<void>;
  };
  deleteOssObject?: (ossObjectName: string) => Promise<void>;
  gotrue?: GotrueOAuthClient;
  gitea?: GiteaClient;
  deleteSecret?: (kind: string) => Promise<void>;
};

export type TeardownAppInput = {
  appId: string;
  fcFunctionName?: string | null;
  authMode?: AuthMode | string | null;
  oauthClientId?: string | null;
  gitAuthKind?: string | null;
  gitRemoteUrl?: string | null;
};

/** Best-effort teardown of deploy-time external resources (§7.2). */
export async function teardownAppResources(
  deps: TeardownAppDeps,
  input: TeardownAppInput,
): Promise<{ archivedRepoUrl: string | null }> {
  const functionName = input.fcFunctionName?.trim() || appFunctionName(input.appId);

  if (deps.fcOps) {
    try {
      if (deps.fcOps.deleteHttpTrigger) {
        await deps.fcOps.deleteHttpTrigger(functionName);
      }
      await deps.fcOps.deleteFunction(functionName);
    } catch {
      // FC may already be gone; delete must still proceed.
    }
  }

  if (deps.deleteOssObject) {
    try {
      await deps.deleteOssObject(appOssObjectName(input.appId));
    } catch {
      // Artifact may never have been uploaded.
    }
  }

  const authMode = input.authMode ?? "none";
  if (authMode === "platform" && input.oauthClientId && deps.gotrue) {
    try {
      await deps.gotrue.disableOAuthClient(input.oauthClientId);
    } catch {
      // Client may already be deleted.
    }
  }
  if (authMode === "platform" && deps.deleteSecret) {
    try {
      await deps.deleteSecret(OAUTH_CLIENT_SECRET_KIND);
    } catch {
      // Row cascades on app delete; this is for deployments without the row yet.
    }
  }

  if (input.gitAuthKind !== GITEA_AUTH_KIND || !deps.gitea) {
    return { archivedRepoUrl: input.gitRemoteUrl ?? null };
  }

  let archivedRepoUrl: string | null = input.gitRemoteUrl ?? null;
  try {
    await revokeAllDeployKeys(deps.gitea, input.appId);
    const patched = await deps.gitea.archiveAndRenameAppRepo(input.appId);
    archivedRepoUrl = patched.sshUrl ?? archivedRepoUrl;
  } catch {
    // Gitea failure must not block the DB delete; ops can reconcile manually.
  }
  return { archivedRepoUrl };
}

export function makeTeardownAppDeps(profile: {
  bucket: string;
  s3: { send: (cmd: unknown) => Promise<unknown> };
  fcOps: TeardownAppDeps["fcOps"];
}): Pick<TeardownAppDeps, "fcOps" | "deleteOssObject"> {
  return {
    fcOps: profile.fcOps
      ? {
          deleteHttpTrigger: profile.fcOps.deleteHttpTrigger?.bind(profile.fcOps),
          deleteFunction: profile.fcOps.deleteFunction.bind(profile.fcOps),
        }
      : undefined,
    deleteOssObject: async (ossObjectName) => {
      await profile.s3.send(
        new DeleteObjectCommand({ Bucket: profile.bucket, Key: ossObjectName }),
      );
    },
  };
}
