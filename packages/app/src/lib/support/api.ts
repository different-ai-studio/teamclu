import { createAuthClient, createAuthModule } from "@/lib/backend/cloud-api/auth";
import { createCloudApiClient, type CloudApiClient } from "@/lib/backend/cloud-api/http";
import { getEffectiveServerConfigSync } from "@/lib/config/server-config";

export interface SupportRedeemResult {
  sessionId: string;
  phase: string;
  status: string;
}

export interface SupportSessionView {
  sessionId: string;
  status: string;
  phase: string;
  supportDisplayName: string | null;
  bundle: unknown;
  conclusion: string | null;
  expiresAt: string;
}

function supportClient(): CloudApiClient {
  const baseUrl = getEffectiveServerConfigSync().cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Cloud API URL is not configured.");
  const authClient = createAuthClient({ baseUrl });
  const auth = createAuthModule(null as unknown as CloudApiClient, authClient);
  return createCloudApiClient({ baseUrl, auth });
}

export async function redeemSupportCode(code: string): Promise<SupportRedeemResult> {
  return supportClient().post<SupportRedeemResult>("/v1/support-sessions/redeem", { code });
}

export async function fetchSupportSession(sessionId: string): Promise<SupportSessionView> {
  return supportClient().get<SupportSessionView>(
    `/v1/support-sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function submitSupportConclusion(sessionId: string, text: string): Promise<void> {
  await supportClient().post(`/v1/support-sessions/${encodeURIComponent(sessionId)}/conclusion`, {
    text,
  });
}

export async function closeSupportSession(sessionId: string): Promise<void> {
  await supportClient().post(`/v1/support-sessions/${encodeURIComponent(sessionId)}/close`, {
    reason: "support_closed",
  });
}
