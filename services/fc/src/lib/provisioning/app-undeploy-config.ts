import { makeTeardownAppDeps } from './app-delete.js';
import { resolveAppsOss, getAppsS3Client } from './apps-oss.js';
import { getFcClient, makeFcOps, readAppsFcVpcConfig, resolveFcEndpoint } from './fc-client.js';
import { makeGotrueOAuthClient, readGotrueOAuthConfig } from './gotrue-oauth.js';
import type { AppUndeployDeps } from './app-undeploy.js';
/** Called by the authenticated heartbeat, which intentionally has no business repository. */
export function makeAppUndeployDeps(): AppUndeployDeps {
    const resolved = resolveAppsOss();
    if (resolved.error)
        return {};
    const profile = resolved.profile;
    const fcOps = resolveFcEndpoint() ? makeFcOps(getFcClient(profile), { bucket: profile.bucket, role: process.env.ROLE_ARN, region: profile.region, vpc: readAppsFcVpcConfig() }) : undefined;
    const teardown = makeTeardownAppDeps({ bucket: profile.bucket, s3: getAppsS3Client(profile), fcOps });
    const oauth = readGotrueOAuthConfig();
    const gotrue = oauth.error ? undefined : makeGotrueOAuthClient(oauth.config);
    return { deleteHttpTrigger: teardown.fcOps?.deleteHttpTrigger, deleteFunction: teardown.fcOps?.deleteFunction, deleteCustomDomain: teardown.fcOps?.deleteCustomDomain, deleteArtifact: teardown.deleteOssObject, disableOAuthClient: gotrue?.disableOAuthClient };
}
