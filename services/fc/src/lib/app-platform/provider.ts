/**
 * The cloud underneath the app platform, as the platform's own code sees it.
 *
 * Three drivers, one per capability that sits on a vendor SDK today:
 * compute (Function Compute), object storage (OSS / S3 + STS) and logs (SLS).
 * The platform's other dependencies are already vendor-neutral and stay where
 * they are: the image registry is any Docker registry (config only, the push
 * happens on the developer's machine), the database is a Postgres URL, and the
 * edge is Caddy / Traefik plus DNS.
 *
 * Everything outside `app-platform/` reaches the cloud through
 * {@link resolveAppPlatform}; only `aliyun/` constructs SDK clients, which
 * `test/app-platform/boundary.test.ts` enforces. Swapping the provider — a fake
 * in tests, another vendor later — means implementing these interfaces, not
 * editing the deploy path.
 *
 * The method shapes are the ones the deploy, teardown, storage and logs code
 * already consumed from the Aliyun wrappers, unchanged: this step draws the
 * line, it does not redesign what crosses it. See
 * docs/specs/2026-11-24-app-platform-infra-decoupling-design.md §4 / §8 (P0).
 */
import type { OriginSecuritySummary, OriginTarget } from "../apps-origin-auth.js";
import type { RuntimeDiscovery } from "../provisioning/app-runtime-catalog.js";
import type { AppStorageOps } from "../provisioning/app-storage.js";
import type { EnsureFunctionArgs, FcOpsConfig } from "./aliyun/fc.js";
import type { SlsRow } from "./aliyun/sls.js";

/** What a caller may tune per use; bucket, region, execution role and network come from the provider. */
export type ComputeOptions = Omit<FcOpsConfig, "bucket" | "region" | "role" | "vpc"> & {
  /** Defaults to the platform region. */
  region?: string;
};

/** Where a just-written function stands: servable, still starting, or failed. */
export type FunctionReadiness =
  | { status: "ready" }
  | { status: "pending"; reason?: string }
  | { status: "failed"; reason: string }
  | { status: "timeout"; reason?: string };

/** The compute platform says a function failed to start or to apply its last update. */
export class FunctionNotReadyError extends Error {
  constructor(readonly functionName: string, readonly reason: string) {
    super(`the platform could not start ${functionName}: ${reason}`);
    this.name = "FunctionNotReadyError";
  }
}

/** Operations on one app's function and its entrypoints. */
export interface ComputeOps {
  ensureFunction(functionName: string, args: EnsureFunctionArgs): Promise<void>;
  /**
   * Resolve once the platform can serve the function `ensureFunction` wrote,
   * or with `timeout`; throw {@link FunctionNotReadyError} when it failed.
   */
  waitUntilReady(functionName: string): Promise<FunctionReadiness>;
  setMinInstances(functionName: string, minInstances: number): Promise<{ changed: boolean }>;
  deleteFunction(functionName: string): Promise<void>;
  deleteHttpTrigger(functionName: string): Promise<void>;
  ensureHttpTrigger(functionName: string): Promise<{ internetUrlDisabled: true }>;
  ensurePrivateOrigin(functionName: string, target: OriginTarget): Promise<string>;
  readPrivateOrigin(functionName: string, target: OriginTarget): Promise<string>;
  readPrivateOriginSecurity(
    functionName: string,
    target: OriginTarget,
    storedEndpoint: string,
  ): Promise<OriginSecuritySummary>;
  ensureCustomDomain(functionName: string, domainName: string, target: OriginTarget): Promise<string>;
  readOriginSecurity(
    functionName: string,
    domainName: string,
    target: OriginTarget,
  ): Promise<OriginSecuritySummary>;
  deleteCustomDomain(domainName: string): Promise<void>;
}

export interface ComputeDriver {
  /**
   * Whether calls can reach the provider at all. A method, not a field:
   * resolving the endpoint can throw (an explicit endpoint for another region),
   * and that must surface where the caller asks, as it always has — not when
   * the platform is resolved for, say, the file browser.
   */
  configured(): boolean;
  /**
   * Whether app functions join the private network the apps database sits on.
   * The provider attaches them itself on create / update; callers only ask, to
   * refuse a data_app deploy whose function could not reach its database.
   */
  joinsPrivateNetwork(): boolean;
  ops(options?: ComputeOptions): ComputeOps;
  /** The provider's raw view of one function, for drift checks. */
  getFunction(functionName: string, region: string): Promise<unknown>;
  /** What the provider can run, per region: documented runtimes and current layers. */
  readonly runtimes: RuntimeDiscovery;
}

export interface ObjectStoreDriver {
  /** A URL the developer's machine PUTs the build artifact to. */
  presignPut(key: string, expiresInSeconds: number): Promise<string>;
  /**
   * The S3-style client teardown sends its delete through
   * (`makeTeardownAppDeps`). Structural so a fake needs only `send`.
   */
  readonly client: { send(command: unknown): Promise<unknown> };
  /** The app file store: listing, signed links, quotas, scoped STS credentials. */
  storage(): AppStorageOps;
}

export interface LogsOps {
  /** Create the project, logstore and index if absent. */
  ensureLogStore(): Promise<void>;
  fetchWindow(args: { topic: string; from: number; to: number; maxRows: number }): Promise<SlsRow[]>;
}

export type LogsDriver =
  | { ops: LogsOps; destination: { project: string; logstore: string }; unavailableReason?: undefined }
  | { ops?: undefined; destination?: undefined; unavailableReason: string };

export interface AppPlatform {
  /** Where app functions run and the artifact bucket lives. */
  readonly region: string;
  /** The artifact bucket (`apps/<appId>/code.zip`). */
  readonly bucket: string;
  readonly compute: ComputeDriver;
  readonly objectStore: ObjectStoreDriver;
  readonly logs: LogsDriver;
}

export type AppPlatformResolution =
  | { platform: AppPlatform; error?: undefined }
  | { platform?: undefined; error: string };
