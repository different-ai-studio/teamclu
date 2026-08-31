import { json } from "./responses.js";
import { sha256, ossGet, ossPut } from "./oss-store.js";
import { litellmFetch, LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD } from "./litellm.js";
import { dispatchPush } from "./push-dispatch.js";
import { pushDeps } from "./push-deps.js";
import { sharedSecretMatches } from "./shared-secret.js";

// Re-exported for index.ts (push webhook wiring) and any legacy importers.
export { json } from "./responses.js";
export { pushDeps } from "./push-deps.js";

const PUSH_WEBHOOK_SECRET = () => process.env.PUSH_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// Route handlers
//
// These are intentionally thin: each parses/validates its request body, then
// orchestrates the OSS team registry (oss-store), the LiteLLM proxy (litellm),
// or push dispatch (push-deps + push-dispatch).
// All infra lives in those modules.
//
// /register, /token and /apply used to live here. They minted Alibaba STS
// credentials for the direct-to-OSS team drive, which no longer exists — team
// blobs are in Supabase Storage and every client goes through /v1. Nothing had
// called them for months.
// ---------------------------------------------------------------------------
export async function handleResetSecret(body: any) {
  const { teamId, oldSecret, newSecret } = body;
  const ownerNodeId = body.ownerActorId ?? body.ownerNodeId;
  if (!teamId || !oldSecret || !newSecret || !ownerNodeId) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(oldSecret) !== auth.teamSecretHash) {
    console.log(`[reset-secret] Old secret mismatch for teamId=${teamId}`);
    return json(403, { error: "Invalid old secret" });
  }

  if (ownerNodeId !== auth.ownerNodeId) {
    console.log(`[reset-secret] Owner mismatch for teamId=${teamId}`);
    return json(403, { error: "Only the owner can reset the secret" });
  }

  auth.teamSecretHash = sha256(newSecret);
  await ossPut(`teams/${teamId}/_registry/auth.json`, auth);

  console.log(`[reset-secret] Secret updated for teamId=${teamId}`);
  return json(200, { success: true });
}

export async function handleManagedGitSetupLitellm(body: any) {
  // ownerActorId is the owner's actor_id; the owner LiteLLM key is seeded from
  // it (sk-tc-{actor_id[..40]}) to match the desktop runtime token.
  const { teamId, teamSecret, teamName, ownerName } = body;
  const ownerNodeId = body.ownerActorId ?? body.ownerNodeId;
  if (!teamId || !teamSecret || !ownerNodeId) {
    return json(400, { error: "Missing teamId, teamSecret, or ownerActorId" });
  }

  const teamSecretHash = sha256(teamSecret);
  const existing = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (existing) {
    if (existing.teamSecretHash !== teamSecretHash) {
      return json(403, { error: "Team already registered with different secret" });
    }
  } else {
    const createdAt = new Date().toISOString();
    await ossPut(`teams/${teamId}/_registry/auth.json`, {
      schemaVersion: 1,
      teamSecretHash,
      ownerNodeId,
      createdAt,
    });
    await ossPut(`teams/${teamId}/_meta/team.json`, {
      schemaVersion: 1,
      teamId,
      teamName: teamName || teamId,
      ownerName: ownerName || "",
      ownerNodeId,
      createdAt,
    });
    console.log(`[managed-git/setup-litellm] Registered teamId=${teamId} owner=${ownerNodeId.slice(0, 8)}`);
  }

  const litellmTeamId = `tc-${teamId}`;
  const maxBudget = LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD();
  const teamRes = await litellmFetch("/team/new", "POST", {
    team_id: litellmTeamId,
    team_alias: teamName || teamId,
    max_budget: maxBudget,
  });
  if (!teamRes.ok && teamRes.status !== 409) {
    console.error(`[managed-git/setup-litellm] team/new error:`, teamRes.data);
    return json(502, { error: "Failed to create LiteLLM team", detail: teamRes.data });
  }

  const keyAlias = `${ownerName || "owner"}-${ownerNodeId.slice(0, 8)}`;
  const keyValue = `sk-tc-${ownerNodeId.slice(0, 40)}`;
  const keyRes = await litellmFetch("/key/generate", "POST", {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: keyAlias,
  });
  if (!keyRes.ok) {
    console.error(`[managed-git/setup-litellm] key/generate error:`, keyRes.data);
    return json(502, { error: "Failed to create owner key", detail: keyRes.data });
  }

  console.log(
    `[managed-git/setup-litellm] team=${litellmTeamId} owner=${ownerNodeId.slice(0, 8)} max_budget_usd=${maxBudget}`
  );
  return json(200, {
    success: true,
    litellmTeamId,
    key: keyValue,
    keyAlias,
    maxBudgetUsd: maxBudget,
  });
}

export async function handlePushDispatch(headers: Record<string, string> | undefined, body: any) {
  if (!sharedSecretMatches(headers?.['x-webhook-secret'], PUSH_WEBHOOK_SECRET())) {
    return json(401, { error: 'Unauthorized' });
  }
  if (body.type !== 'INSERT' || body.table !== 'messages') {
    return json(200, { skipped: 'not_a_message_insert' });
  }
  try {
    const result = await dispatchPush(body.record, pushDeps());
    return json(200, result);
  } catch (err: any) {
    console.error('[push] dispatch error', err);
    return json(500, { error: String(err.message || err) });
  }
}
