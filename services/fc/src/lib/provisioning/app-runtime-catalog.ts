import * as $fc from "@alicloud/fc20230330";
import { getFcClient } from "./fc-client.js";
import { resolveAppsOss } from "./apps-oss.js";

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
type LayerMetadata = Pick<$fc.Layer, "layerName" | "version" | "layerVersionArn" | "compatibleRuntime">;
export interface CatalogClient {
  listLayers(request: $fc.ListLayersRequest): Promise<{ body?: { layers?: LayerMetadata[]; nextToken?: string } }>;
  listLayerVersions(name: string, request: $fc.ListLayerVersionsRequest): Promise<{ body?: { layers?: LayerMetadata[]; nextVersion?: number } }>;
}
const DOC_URL = "https://api.alibabacloud.com/api/FC/2023-03-30/CreateFunction";
// Documentation snapshot, not a ListRuntimes result or regional availability guarantee.
const DOCUMENTED = ["nodejs12", "nodejs14", "nodejs16", "nodejs18", "nodejs20", "go1", "python3", "python3.9", "python3.10", "python3.12", "java8", "java11", "php7.2", "dotnetcore3.1", "custom", "custom.debian10", "custom.debian11", "custom.debian12", "custom-container"];
/** Historical serving evidence covers only these versions on custom.debian10. The provider must also list the exact regional ARN and runtime. */
const VERIFIED_NODE20_VERSIONS = new Set([1, 2, 3]);
function verifiedLayer(name: string, version: LayerMetadata, region: string): boolean {
  return name === "Nodejs20" && VERIFIED_NODE20_VERSIONS.has(version.version ?? -1) &&
    version.layerVersionArn === `acs:fc:${region}:official:layers/Nodejs20/versions/${version.version}` &&
    (version.compatibleRuntime ?? []).includes("custom.debian10");
}
function languageOf(name: string): AppLanguage | undefined {
  return /^(node|python|go|php|java)/i.exec(name)?.[1].toLowerCase() as AppLanguage | undefined;
}
function documented(region: string): RuntimeCandidate[] {
  return DOCUMENTED.map(name => ({ name, region, source: "documentation", language: languageOf(name), compatibleRuntime: [name],
    teamcluDeployable: name.startsWith("custom") ? "teamcluDeployable" : "providerAvailableButUnsupported",
    reason: name.startsWith("custom") ? "TeamClu supports this HTTP runtime contract; artifact and startup still require verification." : "Built-in handler runtime is outside TeamClu's custom HTTP app contract." }));
}
export function createRuntimeCatalogReader(clientForRegion: (region: string) => CatalogClient,
  options: { now?: () => number; ttlMs?: number; maxRegions?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttl = Math.max(1, options.ttlMs ?? 60_000);
  const maxRegions = Math.max(1, options.maxRegions ?? 8);
  const cache = new Map<string, { at: number; candidates: RuntimeCandidate[]; state: SourceState }>();
  return async (region: string, language?: AppLanguage): Promise<{ candidates: RuntimeCandidate[]; sourceStatus: SourceStatus }> => {
    const time = now(); const checkedAt = new Date(time).toISOString();
    let entry = cache.get(region);
    if (!entry || time - entry.at >= ttl) {
      const candidates: RuntimeCandidate[] = []; const errors: string[] = [];
      try {
        const client = clientForRegion(region);
        const tokens = new Set<string>(); let nextToken: string | undefined;
        do {
          const page = (await client.listLayers(new $fc.ListLayersRequest({ official: "true", limit: 100, nextToken }))).body;
          if (!page || !Array.isArray(page.layers)) throw new Error("Invalid ListLayers response");
          for (const layer of page.layers) {
            const name = layer.layerName;
            if (!name) { errors.push("ListLayers: missing layer name"); continue; }
            try {
              let startVersion: string | undefined; const versions = new Set<string>();
              do {
                const page = (await client.listLayerVersions(name, new $fc.ListLayerVersionsRequest({ limit: 100, startVersion }))).body;
                if (!page || !Array.isArray(page.layers)) throw new Error("Invalid ListLayerVersions response");
                for (const version of page.layers) {
                  const verified = verifiedLayer(name, version, region);
                  candidates.push({ name, source: "officialLayers", region, language: languageOf(name), version: version.version,
                    arn: version.layerVersionArn, compatibleRuntime: version.compatibleRuntime ?? [],
                    teamcluDeployable: verified ? "teamcluDeployable" : "unknown",
                    ...(verified ? { teamcluVerifiedRuntime: ["custom.debian10"] } : {}),
                    reason: verified
                      ? "Nodejs20 versions 1–3 served from /opt/nodejs20 on custom.debian10 in historical TeamClu deployments; provider confirms this regional ARN and runtime."
                      : "Provider metadata does not verify interpreter paths, mount points, or HTTP startup compatibility." });
                }
                startVersion = page.nextVersion && page.nextVersion > 0 ? String(page.nextVersion) : undefined;
                if (startVersion && versions.has(startVersion)) throw new Error("Repeated layer version cursor");
                if (startVersion) versions.add(startVersion);
              } while (startVersion);
            } catch (error) { errors.push(`${name}: ${errorCode(error)}`); }
          }
          nextToken = page.nextToken || undefined;
          if (nextToken && tokens.has(nextToken)) throw new Error("Repeated layer list cursor");
          if (nextToken) tokens.add(nextToken);
        } while (nextToken);
      } catch (error) { errors.push(`ListLayers: ${errorCode(error)}`); }
      const stale = errors.length > 0 && !!entry;
      entry = { at: time, candidates: stale ? [...entry!.candidates, ...candidates.filter(c => !entry!.candidates.some(old => old.arn === c.arn))] : candidates,
        state: { checkedAt, observedAt: stale ? entry!.state.observedAt : checkedAt, complete: errors.length === 0,
          stale, errors, provenance: "Alibaba FC 2023-03-30 ListLayers / ListLayerVersions" } };
      cache.delete(region); cache.set(region, entry);
      while (cache.size > maxRegions) cache.delete(cache.keys().next().value!);
    }
    return structuredClone({ candidates: [...documented(region), ...entry.candidates].filter(c => !language || c.language === language),
      sourceStatus: { documentation: { observedAt: "2026-09-28", checkedAt, complete: true, stale: false, errors: [], provenance: DOC_URL }, officialLayers: entry.state } });
  };
}
// Never expose SDK error messages: they may contain signed URLs or credentials.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : "discovery_unavailable";
}
export const readRuntimeCatalog = createRuntimeCatalogReader(region => {
  const resolved = resolveAppsOss();
  if (!resolved.profile) throw new Error(resolved.error);
  return getFcClient({ ...resolved.profile, region });
});
