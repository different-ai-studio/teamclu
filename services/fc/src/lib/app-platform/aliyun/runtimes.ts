/**
 * What Function Compute can run, as far as TeamClu can tell: a snapshot of the
 * documented runtimes plus the official layers ListLayers publishes for one
 * region right now. Everything here is FC-specific knowledge — the runtime
 * names, the layer ARN shape, which Nodejs20 layers have actually served an
 * app. The cache, the stale fallback and the language filter are
 * vendor-neutral and live in `provisioning/app-runtime-catalog.ts`.
 */
import * as $fc from "@alicloud/fc20230330";
import {
  discoveryErrorCode,
  type AppLanguage,
  type RuntimeCandidate,
  type RuntimeDiscovery,
} from "../../provisioning/app-runtime-catalog.js";

type LayerMetadata = Pick<$fc.Layer, "layerName" | "version" | "layerVersionArn" | "compatibleRuntime">;
export interface CatalogClient {
  listLayers(request: $fc.ListLayersRequest): Promise<{ body?: { layers?: LayerMetadata[]; nextToken?: string } }>;
}
const DOC_URL = "https://api.alibabacloud.com/api/FC/2023-03-30/CreateFunction";
// Documentation snapshot, not a ListRuntimes result or regional availability guarantee.
const DOCUMENTED = ["nodejs12", "nodejs14", "nodejs16", "nodejs18", "nodejs20", "go1", "python3", "python3.9", "python3.10", "python3.12", "java8", "java11", "php7.2", "dotnetcore3.1", "custom", "custom.debian10", "custom.debian11", "custom.debian12", "custom-container"];
const DOCUMENTED_AT = "2026-09-28";
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

/**
 * Runtime discovery over an FC client per region. `clientForRegion` may throw
 * (an endpoint pinned to another region): that is reported as a ListLayers
 * error, like a failed page, never as a thrown catalog read.
 */
export function aliyunRuntimeDiscovery(clientForRegion: (region: string) => CatalogClient): RuntimeDiscovery {
  return {
    documented: region => ({ candidates: documented(region), observedAt: DOCUMENTED_AT, provenance: DOC_URL }),
    currentProvenance: "Alibaba FC 2023-03-30 ListLayers (current published official versions only)",
    async listCurrent(region) {
      const candidates: RuntimeCandidate[] = []; const errors: string[] = [];
      try {
        const client = clientForRegion(region);
        const tokens = new Set<string>(); let nextToken: string | undefined;
        do {
          const page = (await client.listLayers(new $fc.ListLayersRequest({ official: "true", limit: 100, nextToken }))).body;
          if (!page || !Array.isArray(page.layers)) throw new Error("Invalid ListLayers response");
          for (const layer of page.layers) {
            const name = layer.layerName; const version = layer.version; const arn = layer.layerVersionArn;
            if (!name || !Number.isInteger(version) || !version || !arn || !Array.isArray(layer.compatibleRuntime) ||
                !arn.startsWith(`acs:fc:${region}:`) || !arn.endsWith(`:layers/${name}/versions/${version}`)) {
              errors.push(`${name || "ListLayers"}: incomplete current layer metadata`); continue;
            }
            const verified = verifiedLayer(name, layer, region);
            candidates.push({ name, source: "officialLayers", region, language: languageOf(name), version,
              arn, compatibleRuntime: layer.compatibleRuntime,
              teamcluDeployable: verified ? "teamcluDeployable" : "unknown",
              ...(verified ? { teamcluVerifiedRuntime: ["custom.debian10"] } : {}),
              reason: verified
                ? "Nodejs20 versions 1–3 served from /opt/nodejs20 on custom.debian10 in historical TeamClu deployments; provider confirms this regional ARN and runtime."
                : "Provider metadata does not verify interpreter paths, mount points, or HTTP startup compatibility." });
          }
          nextToken = page.nextToken || undefined;
          if (nextToken && tokens.has(nextToken)) throw new Error("Repeated layer list cursor");
          if (nextToken) tokens.add(nextToken);
        } while (nextToken);
      } catch (error) { errors.push(`ListLayers: ${discoveryErrorCode(error)}`); }
      return { candidates, errors };
    },
  };
}
