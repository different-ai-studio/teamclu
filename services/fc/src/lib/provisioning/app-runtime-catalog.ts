import { resolveAppPlatform } from "../app-platform/index.js";

export type AppLanguage = "node" | "python" | "go" | "php" | "java";
export interface RuntimeCandidate {
  name: string;
  source: "documentation" | "officialLayers";
  region: string;
  language?: AppLanguage;
  version?: number;
  arn?: string;
  compatibleRuntime: string[];
  teamcluDeployable: "teamcluDeployable" | "providerAvailableButUnsupported" | "unknown";
  /** Runtime/image pairs actually verified by TeamClu, narrower than provider compatibility. */
  teamcluVerifiedRuntime?: string[];
  reason: string;
}
export interface SourceState {
  observedAt: string | null;
  checkedAt: string;
  complete: boolean;
  stale: boolean;
  errors: string[];
  provenance: string;
}
export interface SourceStatus { documentation: SourceState; officialLayers: SourceState }

/**
 * Where the candidates come from. One per provider (`ComputeDriver.runtimes`);
 * this module owns only what is the same for every provider: the per-region
 * cache, the stale fallback when a refresh fails, and the language filter.
 */
export interface RuntimeDiscovery {
  /** Runtimes the provider documents. Static, so read on every call. */
  documented(region: string): { candidates: RuntimeCandidate[]; observedAt: string; provenance: string };
  /**
   * What the provider lists for this region right now. Never throws: partial
   * candidates come back with an error per problem, as codes only.
   */
  listCurrent(region: string): Promise<{ candidates: RuntimeCandidate[]; errors: string[] }>;
  readonly currentProvenance: string;
}

/**
 * `discoveryFor` may throw (no provider configured): the catalog then answers
 * with no candidates and both sources marked incomplete, naming the code.
 */
export function createRuntimeCatalogReader(discoveryFor: () => RuntimeDiscovery,
  options: { now?: () => number; ttlMs?: number; maxRegions?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttl = Math.max(1, options.ttlMs ?? 60_000);
  const maxRegions = Math.max(1, options.maxRegions ?? 8);
  const cache = new Map<string, { at: number; candidates: RuntimeCandidate[]; state: SourceState }>();
  return async (region: string, language?: AppLanguage): Promise<{ candidates: RuntimeCandidate[]; sourceStatus: SourceStatus }> => {
    const time = now(); const checkedAt = new Date(time).toISOString();
    let discovery: RuntimeDiscovery | undefined; let unavailable: string | undefined;
    try { discovery = discoveryFor(); } catch (error) { unavailable = `discovery: ${discoveryErrorCode(error)}`; }
    let entry = cache.get(region);
    if (!entry || time - entry.at >= ttl) {
      const { candidates, errors } = discovery
        ? await discovery.listCurrent(region)
        : { candidates: [] as RuntimeCandidate[], errors: [unavailable!] };
      const stale = errors.length > 0 && !!entry;
      entry = { at: time, candidates: stale ? [...entry!.candidates, ...candidates.filter(c => !entry!.candidates.some(old => old.arn === c.arn))] : candidates,
        state: { checkedAt, observedAt: stale ? entry!.state.observedAt : checkedAt, complete: errors.length === 0,
          stale, errors, provenance: discovery?.currentProvenance ?? entry?.state.provenance ?? "unavailable" } };
      cache.delete(region); cache.set(region, entry);
      while (cache.size > maxRegions) cache.delete(cache.keys().next().value!);
    }
    const docs = discovery?.documented(region);
    const documentation: SourceState = docs
      ? { observedAt: docs.observedAt, checkedAt, complete: true, stale: false, errors: [], provenance: docs.provenance }
      : { observedAt: null, checkedAt, complete: false, stale: false, errors: [unavailable!], provenance: "unavailable" };
    return structuredClone({ candidates: [...(docs?.candidates ?? []), ...entry.candidates].filter(c => !language || c.language === language),
      sourceStatus: { documentation, officialLayers: entry.state } });
  };
}
// Never expose SDK error messages: they may contain signed URLs or credentials.
export function discoveryErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : "discovery_unavailable";
}
export const readRuntimeCatalog = createRuntimeCatalogReader(() => {
  const resolved = resolveAppPlatform();
  if (!resolved.platform) throw new Error(resolved.error);
  return resolved.platform.compute.runtimes;
});
