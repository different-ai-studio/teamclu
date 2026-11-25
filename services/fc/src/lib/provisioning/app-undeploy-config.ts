import { makeTeardownAppDeps } from './app-delete.js';
import { makeGotrueOAuthClient, readGotrueOAuthConfig } from './gotrue-oauth.js';
import { resolveAppPlatform } from '../app-platform/index.js';
import type { AppUndeployDeps } from './app-undeploy.js';
/** Called by the authenticated heartbeat, which intentionally has no business repository. */
export function makeAppUndeployDeps(): AppUndeployDeps {
    const resolved = resolveAppPlatform();
    if (resolved.error)
        return {};
    const platform = resolved.platform;
    const fcOps = platform.compute.configured() ? platform.compute.ops() : undefined;
    const teardown = makeTeardownAppDeps({ bucket: platform.bucket, s3: platform.objectStore.client, fcOps });
    const oauth = readGotrueOAuthConfig();
    const gotrue = oauth.error ? undefined : makeGotrueOAuthClient(oauth.config);
    return { deleteHttpTrigger: teardown.fcOps?.deleteHttpTrigger, deleteFunction: teardown.fcOps?.deleteFunction, deleteCustomDomain: teardown.fcOps?.deleteCustomDomain, deleteArtifact: teardown.deleteOssObject, disableOAuthClient: gotrue?.disableOAuthClient };
}
