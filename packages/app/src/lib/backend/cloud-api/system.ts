import type { SystemBackend } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createSystemModule(client: CloudApiClient): SystemBackend {
  return {
    async heartbeat() {
      await client.post<void>("/v1/heartbeat", {});
    },
  };
}
