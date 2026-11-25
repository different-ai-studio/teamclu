/**
 * An in-memory {@link AppPlatform} for tests: deploy, teardown and logs run
 * through the real wiring (`src/lib/app-platform/deps.ts`) and land here instead of in Alibaba
 * Cloud, so the platform's behaviour can be checked without credentials.
 *
 * It records what the platform asked for; it does not emulate the provider's
 * validation (Function Compute rejecting a missing start declaration, OSS
 * signature rules). Those stay covered by the Aliyun wrappers' own tests.
 */
import type { OriginSecuritySummary, OriginTarget } from "../../../src/lib/apps-origin-auth.js";
import type { EnsureFunctionArgs } from "../../../src/lib/app-platform/aliyun/fc.js";
import type { SlsRow } from "../../../src/lib/app-platform/aliyun/sls.js";
import type { AppPlatform, ComputeOps, ComputeOptions, LogsDriver } from "../../../src/lib/app-platform/provider.js";

export interface FakeAppPlatformState {
  functions: Map<string, EnsureFunctionArgs & { options: ComputeOptions }>;
  httpTriggers: Set<string>;
  /** domain → function name */
  customDomains: Map<string, string>;
  minInstances: Map<string, number>;
  /** keys a presigned PUT was minted for */
  presignedKeys: string[];
  deletedObjects: string[];
  logStoreEnsured: boolean;
  logRows: SlsRow[];
  /** Every compute / object-store call, in order, for sequence assertions. */
  calls: string[];
}

export interface FakeAppPlatformOptions {
  region?: string;
  bucket?: string;
  /** `false` reproduces a deployment with no FC endpoint configured. */
  computeConfigured?: boolean;
  /** Whether app functions join the database network (default false). */
  joinsPrivateNetwork?: boolean;
  /** A string reproduces a deployment whose logs are unavailable, with that reason. */
  logsUnavailable?: string;
}

const PROTECTED: OriginSecuritySummary = {
  status: "protected",
  internetUrlDisabled: true,
  customDomainAuth: "jwt",
  httpsOnly: true,
  driftFields: [],
};

export function createFakeAppPlatform(options: FakeAppPlatformOptions = {}): {
  platform: AppPlatform;
  state: FakeAppPlatformState;
} {
  const region = options.region ?? "cn-fake-1";
  const bucket = options.bucket ?? "fake-apps-bucket";
  const state: FakeAppPlatformState = {
    functions: new Map(),
    httpTriggers: new Set(),
    customDomains: new Map(),
    minInstances: new Map(),
    presignedKeys: [],
    deletedObjects: [],
    logStoreEnsured: false,
    logRows: [],
    calls: [],
  };
  const privateOrigin = (name: string) => `https://${name}.private-origin.fake`;

  const ops = (computeOptions: ComputeOptions = {}): ComputeOps => ({
    async ensureFunction(name, args) {
      state.calls.push(`ensureFunction ${name}`);
      state.functions.set(name, { ...args, options: computeOptions });
    },
    async waitUntilReady(name) {
      state.calls.push(`waitUntilReady ${name}`);
      return { status: "ready" };
    },
    async setMinInstances(name, min) {
      state.calls.push(`setMinInstances ${name} ${min}`);
      const changed = state.minInstances.get(name) !== min;
      state.minInstances.set(name, min);
      return { changed };
    },
    async deleteFunction(name) {
      state.calls.push(`deleteFunction ${name}`);
      state.functions.delete(name);
    },
    async deleteHttpTrigger(name) {
      state.calls.push(`deleteHttpTrigger ${name}`);
      state.httpTriggers.delete(name);
    },
    async ensureHttpTrigger(name) {
      state.calls.push(`ensureHttpTrigger ${name}`);
      state.httpTriggers.add(name);
      return { internetUrlDisabled: true };
    },
    async ensurePrivateOrigin(name, _target: OriginTarget) {
      state.calls.push(`ensurePrivateOrigin ${name}`);
      state.httpTriggers.add(name);
      return privateOrigin(name);
    },
    async readPrivateOrigin(name) {
      return privateOrigin(name);
    },
    async readPrivateOriginSecurity() {
      return PROTECTED;
    },
    async ensureCustomDomain(name, domain) {
      state.calls.push(`ensureCustomDomain ${name} ${domain}`);
      state.customDomains.set(domain, name);
      return `http://${domain}`;
    },
    async readOriginSecurity(_name, domain) {
      return state.customDomains.has(domain) ? PROTECTED : { ...PROTECTED, status: "drift", driftFields: ["routeConfig"] };
    },
    async deleteCustomDomain(domain) {
      state.calls.push(`deleteCustomDomain ${domain}`);
      state.customDomains.delete(domain);
    },
  });

  const logs: LogsDriver = options.logsUnavailable
    ? { unavailableReason: options.logsUnavailable }
    : {
        destination: { project: "fake-project", logstore: "fake-logstore" },
        ops: {
          async ensureLogStore() {
            state.logStoreEnsured = true;
          },
          async fetchWindow({ topic, maxRows }) {
            return state.logRows.filter(row => row.__topic__ === topic).slice(0, maxRows);
          },
        },
      };

  const platform: AppPlatform = {
    region,
    bucket,
    compute: {
      configured: () => options.computeConfigured ?? true,
      joinsPrivateNetwork: () => options.joinsPrivateNetwork ?? false,
      ops,
      async getFunction(name) {
        const fn = state.functions.get(name);
        if (!fn) throw Object.assign(new Error("FunctionNotFound"), { statusCode: 404 });
        return fn;
      },
      runtimes: {
        documented: () => ({ candidates: [], observedAt: "2026-01-01", provenance: "fake" }),
        listCurrent: async () => ({ candidates: [], errors: [] }),
        currentProvenance: "fake",
      },
    },
    objectStore: {
      async presignPut(key, expiresInSeconds) {
        state.calls.push(`presignPut ${key}`);
        state.presignedKeys.push(key);
        return `https://${bucket}.oss.fake/${key}?expires=${expiresInSeconds}`;
      },
      client: {
        async send(command: unknown) {
          const name = (command as { constructor?: { name?: string } })?.constructor?.name;
          const input = (command as { input?: { Key?: string } })?.input;
          state.calls.push(`${name} ${input?.Key ?? ""}`.trim());
          if (name === "DeleteObjectCommand" && input?.Key) state.deletedObjects.push(input.Key);
          return {};
        },
      },
      storage() {
        throw new Error("the fake app platform has no file store");
      },
    },
    logs,
  };
  return { platform, state };
}
