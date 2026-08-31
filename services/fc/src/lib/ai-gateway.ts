// ---------------------------------------------------------------------------
// Client for the team AI gateway's internal API (services/ai-gateway).
//
// FC never touches the credits tables directly even though it can reach the
// same database. The gateway is the ledger's only writer (design §4.9.1), and
// two writers with different idempotency rules is how a money table drifts.
// Reads go the same way so both sides agree on period boundaries and shapes.
//
// This client carries NO end-user credential: FC decides who may call what
// (team membership, owner-only) and the gateway trusts the service token.
// ---------------------------------------------------------------------------
import { ApiError } from "./http-utils.js";

/** Fail closed. A blank URL used to mean "guess", which is how a deployment
 *  silently routed AI traffic somewhere it never opted into. */
export const AI_GATEWAY_INTERNAL_URL = () => process.env.AI_GATEWAY_INTERNAL_URL?.trim() || "";
export const AI_GATEWAY_SERVICE_TOKEN = () => process.env.AI_GATEWAY_SERVICE_TOKEN?.trim() || "";

export function aiGatewayConfigured(): boolean {
  return Boolean(AI_GATEWAY_INTERNAL_URL() && AI_GATEWAY_SERVICE_TOKEN());
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  if (!aiGatewayConfigured()) {
    throw new ApiError(
      503,
      "ai_gateway_unavailable",
      "AI gateway is not configured (AI_GATEWAY_INTERNAL_URL / AI_GATEWAY_SERVICE_TOKEN)",
    );
  }
  const url = `${AI_GATEWAY_INTERNAL_URL().replace(/\/+$/, "")}/internal${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_GATEWAY_SERVICE_TOKEN()}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ApiError(502, "ai_gateway_error", "AI gateway is unreachable", { cause });
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    // Surface the gateway's own code where it gave one, so a caller sees
    // `insufficient_credits` rather than a generic upstream failure.
    const code = body?.error?.code ?? "ai_gateway_error";
    const message = body?.error?.message ?? `AI gateway returned ${res.status}`;
    throw new ApiError(res.status >= 500 ? 502 : res.status, code, message);
  }
  return body;
}

export const aiGateway = {
  creditsSummary: (teamId: string) => call(`/teams/${encodeURIComponent(teamId)}/credits/summary`),
  usage: (teamId: string, opts: { range?: string; date?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.range) q.set("range", opts.range);
    if (opts.date) q.set("date", opts.date);
    const s = q.toString();
    return call(`/teams/${encodeURIComponent(teamId)}/credits/usage${s ? `?${s}` : ""}`);
  },
  ledger: (teamId: string, limit?: number) =>
    call(`/teams/${encodeURIComponent(teamId)}/credits/ledger${limit ? `?limit=${limit}` : ""}`),
  topUp: (teamId: string, body: unknown) =>
    call(`/teams/${encodeURIComponent(teamId)}/credits/top-up`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  quotas: (teamId: string) => call(`/teams/${encodeURIComponent(teamId)}/quotas`),
  setQuotas: (teamId: string, body: unknown) =>
    call(`/teams/${encodeURIComponent(teamId)}/quotas`, { method: "PUT", body: JSON.stringify(body) }),
  models: () => call("/models"),
};
