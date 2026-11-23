import { cloudAccessToken } from "../../lib/cloud-api/client";
import { createCloudSessionsApi } from "./cloud-api";

export function createConfiguredSessionsApi(
  client: Parameters<typeof cloudAccessToken>[0],
) {
  return createCloudSessionsApi({ getAccessToken: cloudAccessToken(client) });
}
