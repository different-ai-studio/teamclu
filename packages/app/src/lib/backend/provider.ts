import {
  createCloudApiBackend,
  hasCloudApiBackendConfig,
} from "@/lib/backend/cloud-api";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";
import type { BackendKind, TeamCluBackend } from "@/lib/backend/types";

export const BACKEND_CONFIG_MISSING_MESSAGE =
  "Cloud API URL is not configured. Set cloudApiUrl in server config.";

let backend: TeamCluBackend | null = null;
let backendCacheKey: string | null = null;

export function getBackendKind(): Extract<BackendKind, "cloud_api"> {
  return "cloud_api";
}

export function hasBackendConfig(): boolean {
  const config = getEffectiveServerConfigSync();
  return hasCloudApiBackendConfig(config);
}

export function getBackend(): TeamCluBackend {
  const config = getEffectiveServerConfigSync();
  const cacheKey = `cloud_api:${config.cloudApiUrl ?? ""}`;

  if (!backend || backendCacheKey !== cacheKey) {
backend = createCloudApiBackend(config);
    backendCacheKey = cacheKey;
  }
  return backend;
}

export function resetBackendForTests(): void {
  backend = null;
  backendCacheKey = null;
}
