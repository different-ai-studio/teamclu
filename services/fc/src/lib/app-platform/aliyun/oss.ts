import Credential, { OIDCRoleArnCredentialsProvider } from "@alicloud/credentials";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ACCESS_KEY_ID,
  ACCESS_KEY_SECRET,
  OSS_BUCKET,
  OSS_ENDPOINT,
  OSS_FORCE_PATH_STYLE,
  OSS_REGION,
} from "../../oss.js";
import { appsRegion } from "../region.js";

/**
 * Where an app's built code artifact (`apps/<appId>/code.zip`) is staged, and
 * with which credentials — for BOTH the presigned upload the daemon PUTs to
 * and the OSS object Function Compute reads the code from.
 *
 * Why this is not simply the deployment's default S3 config: on self-host the
 * default one is MinIO (`ACCESS_KEY_ID`/`ACCESS_KEY_SECRET` are the MinIO root
 * credentials, `ENDPOINT` is `https://s3.<host>`, `S3_FORCE_PATH_STYLE=1`).
 * Alibaba Function Compute cannot read code out of a box-local MinIO bucket, so
 * a self-host deployment that wants app deploys needs a SECOND, real Alibaba
 * OSS profile alongside the MinIO one. On the Alibaba FC target both are the
 * same account and no new configuration is needed at all.
 */
interface AppsOssLocation {
  bucket: string;
  region: string;
  endpoint: string;
  /** Only MinIO needs path-style addressing; Alibaba OSS is virtual-host. */
  forcePathStyle: boolean;
}

type AppsRrsa = {
  provider: OIDCRoleArnCredentialsProvider;
  client: InstanceType<typeof Credential.default>;
  stsEndpoint: string;
};

export type AppsOssProfile = AppsOssLocation & (
  { accessKeyId: string; accessKeySecret: string; rrsa?: never }
  | { accessKeyId?: never; accessKeySecret?: never; rrsa: AppsRrsa }
);

export type AppsOssResolution =
  | { profile: AppsOssProfile; error?: undefined }
  | { profile?: undefined; error: string };

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

let cachedRrsa: { key: string; rrsa: AppsRrsa } | undefined;

function resolveAppsRrsa(env: Env): AppsOssResolution {
  const role = trimmed(env.ALIBABA_CLOUD_ROLE_ARN);
  const issuer = trimmed(env.ALIBABA_CLOUD_OIDC_PROVIDER_ARN);
  const token = trimmed(env.ALIBABA_CLOUD_OIDC_TOKEN_FILE);
  if (!role || !issuer || !token) {
    return { error: "App RRSA requires ALIBABA_CLOUD_ROLE_ARN, ALIBABA_CLOUD_OIDC_PROVIDER_ARN, and ALIBABA_CLOUD_OIDC_TOKEN_FILE" };
  }
  const bucket = trimmed(env.APPS_OSS_BUCKET);
  if (!bucket) return { error: "App RRSA requires APPS_OSS_BUCKET" };

  const region = appsRegion(env);
  const stsEndpoint = `sts-vpc.${region}.aliyuncs.com`;
  const key = JSON.stringify([role, issuer, token, stsEndpoint]);
  if (cachedRrsa?.key !== key) {
    const provider = OIDCRoleArnCredentialsProvider.builder()
      .withRoleArn(role)
      .withOIDCProviderArn(issuer)
      .withOIDCTokenFilePath(token)
      .withStsEndpoint(stsEndpoint)
      .build();
    cachedRrsa = {
      key,
      rrsa: { provider, client: new Credential.default(null, provider), stsEndpoint },
    };
  }
  return {
    profile: {
      bucket,
      region,
      endpoint: trimmed(env.APPS_OSS_ENDPOINT) || `https://oss-${region}.aliyuncs.com`,
      forcePathStyle: false,
      rrsa: cachedRrsa.rrsa,
    },
  };
}

export function appsOpenApiCredentials(profile?: AppsOssProfile) {
  if (profile?.rrsa) return { credential: profile.rrsa.client };
  return {
    accessKeyId: profile?.accessKeyId ?? process.env.ACCESS_KEY_ID,
    accessKeySecret: profile?.accessKeySecret ?? process.env.ACCESS_KEY_SECRET,
  };
}

export async function appsRequestCredentials(profile: AppsOssProfile) {
  if (profile.rrsa) {
    const session = await profile.rrsa.provider.getSession();
    return {
      accessKeyId: session.accessKeyId,
      accessKeySecret: session.accessKeySecret,
      securityToken: session.securityToken,
      expiration: new Date(session.expiration),
    };
  }
  return {
    accessKeyId: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    securityToken: undefined,
    expiration: undefined,
  };
}

/**
 * Resolve the apps artifact profile, or explain what is missing.
 *
 * Returning the reason rather than a bare null is deliberate: the failure this
 * replaces surfaced to the user as `deploy provisioning not configured`, which
 * named no variable and cost an SSH session to diagnose.
 */
export function resolveAppsOss(env: Env = process.env): AppsOssResolution {
  const credentialMode = trimmed(env.APPS_ALIYUN_CREDENTIAL_MODE);
  if (credentialMode === "rrsa") return resolveAppsRrsa(env);
  if (credentialMode) return { error: "Unsupported APPS_ALIYUN_CREDENTIAL_MODE" };
  const dedicatedKey = trimmed(env.APPS_ACCESS_KEY_ID);

  // --- Dedicated profile: apps live in a different account than the default
  // S3 config (the self-host shape). Nothing is inherited from ENDPOINT /
  // S3_FORCE_PATH_STYLE — inheriting them is precisely how app code would get
  // presigned into MinIO with an Alibaba key and 403 on upload.
  if (dedicatedKey) {
    const secret = trimmed(env.APPS_ACCESS_KEY_SECRET);
    if (!secret) {
      return { error: "APPS_ACCESS_KEY_ID is set but APPS_ACCESS_KEY_SECRET is empty" };
    }
    const bucket = trimmed(env.APPS_OSS_BUCKET);
    if (!bucket) {
      return {
        error:
          "APPS_ACCESS_KEY_ID is set but APPS_OSS_BUCKET is empty — app code cannot fall back to BUCKET, which belongs to the default (possibly MinIO) endpoint",
      };
    }
    const region = appsRegion(env);
    return {
      profile: {
        bucket,
        region,
        endpoint: trimmed(env.APPS_OSS_ENDPOINT) || `https://oss-${region}.aliyuncs.com`,
        accessKeyId: dedicatedKey,
        accessKeySecret: secret,
        forcePathStyle: false,
      },
    };
  }

  // --- Shared profile: one account for everything (the Alibaba FC target).
  const accessKeyId = ACCESS_KEY_ID(env);
  const accessKeySecret = ACCESS_KEY_SECRET(env);
  if (!accessKeyId || !accessKeySecret) {
    return { error: "ACCESS_KEY_ID / ACCESS_KEY_SECRET are not set" };
  }
  // A bucket override alone is fine (same account, separate bucket for app
  // code); a REGION override alone is not, because ENDPOINT still points at the
  // old region and FC would be handed a cross-region code location.
  if (trimmed(env.APPS_REGION) && trimmed(env.APPS_REGION) !== OSS_REGION(env)) {
    return {
      error:
        `APPS_REGION (${trimmed(env.APPS_REGION)}) differs from REGION (${OSS_REGION(env)}) without a dedicated apps profile — also set APPS_ACCESS_KEY_ID / APPS_ACCESS_KEY_SECRET / APPS_OSS_BUCKET`,
    };
  }
  return {
    profile: {
      bucket: trimmed(env.APPS_OSS_BUCKET) || OSS_BUCKET(env),
      region: OSS_REGION(env),
      endpoint: OSS_ENDPOINT(env),
      accessKeyId,
      accessKeySecret,
      forcePathStyle: OSS_FORCE_PATH_STYLE(env),
    },
  };
}

/** S3 client for the app-artifact bucket — never the default team-blobs one. */
export function getAppsS3Client(profile: AppsOssProfile): S3Client {
  return new S3Client({
    region: profile.region,
    endpoint: profile.endpoint,
    credentials: async () => {
      const credentials = await appsRequestCredentials(profile);
      return {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.accessKeySecret,
        sessionToken: credentials.securityToken,
        expiration: credentials.expiration,
      };
    },
    forcePathStyle: profile.forcePathStyle,
    // Alibaba OSS does not implement AWS's flexible-checksum extension, and
    // since aws-sdk v3.729 the default is `WHEN_SUPPORTED` — which adds
    // `x-amz-sdk-checksum-algorithm` and `x-amz-checksum-crc32` to every
    // PutObject. On a PRESIGNED put those land in the SIGNED query string, and
    // the value is the CRC32 of the body known at signing time: nothing. The
    // browser then uploads the real bytes against a signature that promises an
    // empty payload.
    //
    // Measured 2026-09-10: OSS ACCEPTS such a PUT and answers 200, so this is
    // hardening rather than a fix — the parameters describe a payload that is
    // not the one being sent, and nothing promises OSS keeps ignoring them.
    // (The upload failure that prompted this was the bucket having no CORS
    // rule at all; the preflight never reached the PUT.)
    //
    // `WHEN_REQUIRED` keeps checksums for the operations that genuinely need
    // one and adds none otherwise. Harmless against real S3; the difference is
    // only that an optional checksum is no longer volunteered.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
