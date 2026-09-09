import SlsClient, * as $sls from "@alicloud/sls20201230";
import { Config } from "@alicloud/openapi-client";
import { appsRegion, type AppsOssProfile } from "./apps-oss.js";
import { accountIdFromRoleArn } from "./fc-client.js";

type SlsClientInstance = InstanceType<typeof SlsClient.default>;

/**
 * Where deployed app functions send their logs.
 *
 * Function Compute writes nothing anywhere unless the function carries a
 * `logConfig`, and a function created through our API never had one: of the ten
 * `tc-app-*` functions live on 2026-09-08, nine had `{project:"", logstore:""}`
 * and therefore no retrievable output at all — not in the console, not through
 * any API. This module is the other half of fixing that: the destination has to
 * exist before a function can be pointed at it.
 *
 * One project and one logstore for every app, filtered by `__topic__` (FC names
 * the topic after the function, so the filter is exact). Not one logstore per
 * app: a logstore costs at least one shard, SLS caps how many a project may
 * hold, and the authorization that matters happens in the Cloud API against the
 * app row — never in SLS, which sees one service account.
 */
export interface AppsSlsConfig {
  project: string;
  logstore: string;
  region: string;
}

export type AppsSlsResolution =
  | { config: AppsSlsConfig; error?: undefined }
  | { config?: undefined; error: string };

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

/** Days of log retention. Long enough to debug last week's incident. */
export const APPS_SLS_TTL_DAYS = 14;

/**
 * SLS project names are unique across ALL Alibaba Cloud accounts, so a fixed
 * default would collide with a stranger's project (this is why the FC console
 * generates `serverless-<region>-<uuid>`). The account id makes ours ours.
 */
export function defaultSlsProject(env: Env = process.env): string | null {
  const accountId =
    trimmed(env.ALIYUN_ACCOUNT_ID) || accountIdFromRoleArn(env.ROLE_ARN) || null;
  return accountId ? `teamclu-apps-${accountId}` : null;
}

/**
 * Resolve the log destination, or explain what is missing.
 *
 * `APPS_SLS_PROJECT` exists so a deployment can point at a project it already
 * has — including the one the FC console auto-created the first time somebody
 * switched logs on by hand.
 */
export function resolveAppsSls(env: Env = process.env): AppsSlsResolution {
  const project = trimmed(env.APPS_SLS_PROJECT) || defaultSlsProject(env);
  if (!project) {
    return {
      error:
        "no SLS project: set APPS_SLS_PROJECT, or ALIYUN_ACCOUNT_ID / ROLE_ARN so one can be derived",
    };
  }
  return {
    config: {
      project,
      logstore: trimmed(env.APPS_SLS_LOGSTORE) || "app-logs",
      region: appsRegion(env),
    },
  };
}

/**
 * `profile` carries the Alibaba credentials the app functions run under. Same
 * reasoning as {@link getFcClient}: on a deployment whose default
 * `ACCESS_KEY_ID` is MinIO's, those credentials do not authenticate here.
 */
export function getSlsClient(profile?: AppsOssProfile): SlsClientInstance {
  return new SlsClient.default(
    new Config({
      accessKeyId: profile?.accessKeyId ?? process.env.ACCESS_KEY_ID,
      accessKeySecret: profile?.accessKeySecret ?? process.env.ACCESS_KEY_SECRET,
      // The SDK maps the region to `<region>.log.aliyuncs.com` itself and adds
      // the project as a host prefix per call, so no endpoint is set here.
      regionId: profile?.region ?? appsRegion(),
    }) as any,
  );
}

/** SLS answers "it is already there" with a 4xx and a name, not a 200. */
function isAlreadyExists(e: any): boolean {
  const code = e?.code ?? e?.data?.Code ?? e?.data?.errorCode ?? "";
  return /AlreadyExist/i.test(String(code)) || /already exist/i.test(String(e?.message ?? ""));
}

/** Log entries as SLS returns them: a flat map of string values. */
export type SlsRow = Record<string, string>;

/** `GetLogs` refuses more than this per call, so a window is paged. */
const MAX_LINES_PER_CALL = 100;

export interface FetchWindowArgs {
  /** Exact `__topic__` to read — FC names it after the function. */
  topic: string;
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, inclusive. */
  to: number;
  /** Stop after this many rows, however many pages that takes. */
  maxRows: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeSlsOps(client: any, cfg: AppsSlsConfig) {
  const ops = {
    /**
     * Create the project, the logstore and its index if they are not there.
     *
     * Idempotent and safe to call on every deploy; the calls that matter fail
     * with `*AlreadyExist` the second time. An index is created even though the
     * queries here filter by topic alone: `GetLogs` reads through the index
     * engine, and a logstore without one answers every read with an error.
     */
    async ensureLogStore(): Promise<void> {
      try {
        await client.createProject(
          new $sls.CreateProjectRequest({
            projectName: cfg.project,
            description: "TeamClu deployed apps — function logs",
          }),
        );
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
      try {
        await client.createLogStore(
          cfg.project,
          new $sls.CreateLogStoreRequest({
            logstoreName: cfg.logstore,
            ttl: APPS_SLS_TTL_DAYS,
            shardCount: 2,
            autoSplit: true,
            maxSplitShard: 8,
            telemetryType: "None",
          }),
        );
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
      try {
        await client.createIndex(
          cfg.project,
          cfg.logstore,
          new $sls.CreateIndexRequest({
            body: new $sls.Index({
              // Full text over the whole line, plus the fields a human would
              // want to filter on in the SLS console.
              line: new $sls.IndexLine({
                caseSensitive: false,
                chn: true,
                token: [",", " ", "'", '"', ";", "=", "(", ")", "[", "]", "{", "}", "?", "@", "&", "<", ">", "/", ":", "\n", "\t", "\r"],
              }),
              keys: {
                functionName: new $sls.IndexKey({ type: "text", caseSensitive: false, token: ["-", ":", "/"] }),
                requestId: new $sls.IndexKey({ type: "text", caseSensitive: false, token: ["-"] }),
                instanceID: new $sls.IndexKey({ type: "text", caseSensitive: false, token: ["-"] }),
                statusCode: new $sls.IndexKey({ type: "long" }),
                durationMs: new $sls.IndexKey({ type: "double" }),
              },
            }),
          }),
        );
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
    },

    /** One page. `offset` walks a window that is bigger than one call. */
    async getLogs(args: {
      topic: string;
      from: number;
      to: number;
      line: number;
      offset: number;
    }): Promise<SlsRow[]> {
      const resp = await client.getLogs(
        cfg.project,
        cfg.logstore,
        new $sls.GetLogsRequest({
          from: args.from,
          to: args.to,
          topic: args.topic,
          line: Math.min(args.line, MAX_LINES_PER_CALL),
          offset: args.offset,
          // Newest first: a window is read for what just happened, and the cap
          // should drop the oldest rows rather than the ones being looked for.
          reverse: true,
        }),
      );
      return (resp?.body?.data ?? []) as SlsRow[];
    },

    /** Read a whole time window for one topic, up to `maxRows`. */
    async fetchWindow(args: FetchWindowArgs): Promise<SlsRow[]> {
      const out: SlsRow[] = [];
      let offset = 0;
      while (out.length < args.maxRows) {
        const want = Math.min(MAX_LINES_PER_CALL, args.maxRows - out.length);
        const page = await ops.getLogs({
          topic: args.topic,
          from: args.from,
          to: args.to,
          line: want,
          offset,
        });
        out.push(...page);
        // A short page is the end of the window, not a hint to try again: SLS
        // pages by offset and returns fewer rows only when there are no more.
        if (page.length < want) break;
        offset += page.length;
      }
      return out;
    },
  };
  return ops;
}

export type SlsOps = ReturnType<typeof makeSlsOps>;
