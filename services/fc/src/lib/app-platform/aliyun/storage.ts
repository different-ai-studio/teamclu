import { createHash, createHmac, randomUUID } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { appFilesPrefix, appStorageBucket, defaultStorageQuotaBytes } from "../../provisioning/app-files.js";
import {
  AppStorageUnavailable,
  measurePrefixUsage,
  type AppFileEntry,
  type AppStorageCredentials,
  type AppStorageOps,
} from "../../provisioning/app-storage.js";
import { appsRequestCredentials, type AppsOssProfile } from "./oss.js";

// ---------------------------------------------------------------------------
// Credentials an app uses to reach its own files, and nothing else.
//
// The alternative this rejects is injecting the deployment's long-lived apps
// AccessKey into the function env the way DATABASE_URL is injected. That key
// can read EVERY app's prefix and every app's code.zip, and app code is written
// by an agent and deployed by a user, so it would hand LLM output cross-tenant
// reads. The Postgres side already models the right answer: one shared server,
// one scoped credential per app. STS with a session policy is that, for OSS.
//
// Signing is hand-rolled RPC v1 rather than @alicloud/sts20150401. Not to avoid
// a dependency for its own sake: this exact signer was validated against the
// live account during the 2026-09-09 quota audit, whereas the SDK's request
// shapes have already cost us one wrong guess (`tmpReq.validate is not a
// function` from passing a literal where a Request class was required). Twenty
// lines we have run beat a dependency we would still have to learn.
// ---------------------------------------------------------------------------

type Env = NodeJS.ProcessEnv;

export function readStsRoleArn(env: Env = process.env): string {
  return (env.APPS_STS_ROLE_ARN ?? "").trim();
}

/**
 * The session policy. Effective permission is the intersection of the role's
 * own policy and this one, so this is what confines an app to its prefix.
 *
 * Two statements, not one, because OSS checks them at different scopes: object
 * verbs are authorized against `<bucket>/<key>`, but ListObjects is authorized
 * against the BUCKET. Granting list on the bucket resource alone would let any
 * app enumerate every other app's keys, so the prefix has to travel as a
 * condition. This is the single most dangerous string in the feature and the
 * reason `__tests__/app-storage-policy.test.ts` asserts it verbatim: a wrong
 * policy has no runtime signal at all, it just quietly works too well.
 */
export function buildAppStoragePolicy(bucket: string, appId: string): string {
  const prefix = appFilesPrefix(appId);
  return JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "oss:GetObject",
          "oss:PutObject",
          "oss:DeleteObject",
          "oss:AbortMultipartUpload",
          "oss:ListParts",
          "oss:GetObjectMeta",
        ],
        Resource: [`acs:oss:*:*:${bucket}/${prefix}*`],
      },
      {
        Effect: "Allow",
        Action: ["oss:ListObjects"],
        Resource: [`acs:oss:*:*:${bucket}`],
        Condition: { StringLike: { "oss:Prefix": [`${prefix}*`] } },
      },
    ],
  });
}

/**
 * RoleSessionName appears in ActionTrail, so it names the app rather than being
 * random: "which app touched this object" is the question an audit asks. STS
 * allows 2-64 chars of [A-Za-z0-9.@_-]; a uuid plus the prefix fits.
 */
export function storageSessionName(appId: string): string {
  return `tc-app-${appId}`.slice(0, 64);
}

const encodeRfc3986 = (s: string) =>
  encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");

/** Canonical query string plus signature, per Alibaba RPC signature v1. */
export function signRpcV1(
  params: Record<string, string>,
  accessKeySecret: string,
  method = "POST",
): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join("&");
  const stringToSign = `${method}&${encodeRfc3986("/")}&${encodeRfc3986(canonical)}`;
  const signature = createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
  return `${canonical}&Signature=${encodeRfc3986(signature)}`;
}

export interface AssumeRoleDeps {
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the nonce and timestamp are deterministic. */
  now?: () => Date;
  nonce?: () => string;
}

/**
 * Mint prefix-scoped credentials for one app.
 *
 * `durationSeconds` is requested, not guaranteed: a role's MaxSessionDuration
 * caps it, and the account we run on has never had a custom role to read that
 * ceiling off. Asking for more than the role allows is an error from STS rather
 * than a silent downgrade, so the caller clamps to the role's advertised max
 * and lets STS be the authority on the rest.
 */
export async function assumeAppStorageRole(
  profile: AppsOssProfile,
  input: { appId: string; bucket: string; roleArn: string; durationSeconds?: number },
  deps: AssumeRoleDeps = {},
): Promise<AppStorageCredentials> {
  const doFetch = deps.fetchImpl ?? fetch;
  const credentials = await appsRequestCredentials(profile);
  const now = (deps.now ?? (() => new Date()))();
  const params: Record<string, string> = {
    Action: "AssumeRole",
    Version: "2015-04-01",
    Format: "JSON",
    AccessKeyId: credentials.accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: (deps.nonce ?? randomUUID)(),
    Timestamp: now.toISOString().replace(/\.\d{3}/, ""),
    RoleArn: input.roleArn,
    RoleSessionName: storageSessionName(input.appId),
    Policy: buildAppStoragePolicy(input.bucket, input.appId),
    DurationSeconds: String(input.durationSeconds ?? 3600),
  };
  if (credentials.securityToken) params.SecurityToken = credentials.securityToken;
  const body = signRpcV1(params, credentials.accessKeySecret);
  const stsEndpoint = profile.rrsa?.stsEndpoint ?? "sts.aliyuncs.com";
  const res = await doFetch(`https://${stsEndpoint}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppStorageUnavailable(`STS returned non-JSON (${res.status})`);
  }
  if (!res.ok || !parsed?.Credentials) {
    // The STS message names the missing permission or the bad ARN, and that is
    // the whole diagnostic value here - the previous shape of this failure was
    // "deploy provisioning not configured", which named nothing and cost an SSH
    // session to work out.
    throw new AppStorageUnavailable(
      `AssumeRole failed (${res.status} ${parsed?.Code ?? "unknown"}): ${parsed?.Message ?? text.slice(0, 200)}`,
    );
  }
  const c = parsed.Credentials;
  return {
    accessKeyId: c.AccessKeyId,
    accessKeySecret: c.AccessKeySecret,
    securityToken: c.SecurityToken,
    expiration: c.Expiration,
    bucket: input.bucket,
    prefix: appFilesPrefix(input.appId),
    region: profile.region,
    endpoint: profile.endpoint,
  };
}

// ---------------------------------------------------------------------------
// OSS's batch delete (DeleteMultipleObjects) refuses a request without
// `Content-MD5`: "MissingArgument: Missing Some Required Arguments". AWS SDK v3
// sent one until 3.729; since then a checksum-required operation gets a
// flexible checksum (CRC32) instead, which OSS does not read — so every folder
// delete and every purge failed with HTTP 500. Measured 2026-11-26 against the
// self-host bucket with this SDK (3.1173): as built, MissingArgument; with
// this middleware, deleted.
// ---------------------------------------------------------------------------

export const contentMd5Middleware =
  (next: (args: any) => Promise<any>) =>
  async (args: any): Promise<any> => {
    const request = args?.request;
    const body = request?.body;
    if (request?.headers && (typeof body === "string" || body instanceof Uint8Array)) {
      request.headers["content-md5"] = createHash("md5").update(body).digest("base64");
    }
    return next(args);
  };

function withContentMd5<T>(command: T): T {
  (command as any).middlewareStack?.add(contentMd5Middleware, {
    step: "build",
    name: "ossContentMd5",
    override: true,
  });
  return command;
}

// ---------------------------------------------------------------------------
// The bound operations the repository calls. Built once at startup with the
// apps OSS profile, mirroring `makeAppDataOps` for the data browser: the
// repository stays free of endpoints and credentials, and a deployment with no
// apps profile simply passes `undefined` and gets an actionable 503.
// ---------------------------------------------------------------------------

export function makeAppStorageOps(
  profile: AppsOssProfile,
  s3: S3Client,
  deps: {
    getSignedUrl: (client: S3Client, command: any, opts: { expiresIn: number }) => Promise<string>;
    commands: {
      GetObjectCommand: any;
      PutObjectCommand: any;
      HeadObjectCommand: any;
      DeleteObjectCommand: any;
      DeleteObjectsCommand: any;
      ListObjectsV2Command: any;
    };
    env?: Env;
  },
): AppStorageOps {
  const env = deps.env ?? process.env;
  const C = deps.commands;
  return {
    roleArn: readStsRoleArn(env),
    defaultQuotaBytes: defaultStorageQuotaBytes(env),
    region: profile.region,
    endpoint: profile.endpoint,

    bucketFor(app) {
      return appStorageBucket(app, profile);
    },

    async list(bucket, prefix, { after, limit, delimiter }) {
      const out: any = await s3.send(
        new C.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: delimiter || undefined,
          ContinuationToken: after || undefined,
          MaxKeys: Math.min(Math.max(limit ?? 100, 1), 1000),
        }),
      );
      const items: AppFileEntry[] = (out.Contents ?? [])
        .map((o: any) => ({
          path: String(o.Key ?? "").slice(prefix.length),
          size: Number(o.Size ?? 0),
          lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
          etag: o.ETag ? String(o.ETag).replace(/"/g, "") : null,
        }))
        // A key equal to the prefix itself is a directory marker, not a file;
        // it would render as a nameless row.
        .filter((e: AppFileEntry) => e.path !== "");
      // CommonPrefixes come back as the FULL key prefix; the caller thinks in
      // paths relative to what it asked for, so strip its own prefix back off.
      const folders: string[] = (out.CommonPrefixes ?? [])
        .map((p: any) => String(p.Prefix ?? "").slice(prefix.length))
        .filter((p: string) => p !== "");
      return {
        items,
        folders,
        nextCursor: out.IsTruncated ? (out.NextContinuationToken ?? null) : null,
      };
    },

    signUpload(bucket, key, contentType) {
      // 15 min, against the deploy path's 30: a person picking a file in the
      // control panel uploads it now, whereas the daemon's presigned PUT has to
      // outlive `pnpm install && pnpm build`.
      return deps.getSignedUrl(
        s3,
        new C.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType || undefined }),
        { expiresIn: 900 },
      );
    },

    signDownload(bucket, key, filename) {
      return deps.getSignedUrl(
        s3,
        new C.GetObjectCommand({
          Bucket: bucket,
          Key: key,
          // Without this the browser renders whatever the object's type says,
          // and an HTML file uploaded by one member would run on the OSS origin.
          ResponseContentDisposition: `attachment; filename="${(filename ?? key.split("/").pop() ?? "file").replace(/"/g, "")}"`,
        }),
        { expiresIn: 900 },
      );
    },

    async head(bucket, key) {
      try {
        const out: any = await s3.send(new C.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(out.ContentLength ?? 0), contentType: out.ContentType ?? null };
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
        throw e;
      }
    },

    async remove(bucket, key) {
      await s3.send(new C.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async removePrefix(bucket, prefix) {
      let deleted = 0;
      let token: string | undefined;
      // Bounded the same way measurePrefixUsage is: a purge that cannot finish
      // in one call reports what it removed rather than looping forever inside
      // one HTTP request.
      for (let page = 0; page < 50; page += 1) {
        const out: any = await s3.send(
          new C.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
        );
        const keys = (out.Contents ?? []).map((o: any) => ({ Key: o.Key }));
        if (keys.length > 0) {
          await s3.send(
            withContentMd5(new C.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } })),
          );
          deleted += keys.length;
        }
        if (!out.IsTruncated) break;
        token = out.NextContinuationToken;
      }
      return deleted;
    },

    measure(bucket, prefix) {
      return measurePrefixUsage(s3, bucket, prefix);
    },

    assume(app, durationSeconds) {
      const roleArn = readStsRoleArn(env);
      if (!roleArn) {
        throw new AppStorageUnavailable("APPS_STS_ROLE_ARN is not configured");
      }
      return assumeAppStorageRole(profile, {
        appId: app.id,
        bucket: appStorageBucket(app, profile),
        roleArn,
        durationSeconds,
      });
    },
  };
}
