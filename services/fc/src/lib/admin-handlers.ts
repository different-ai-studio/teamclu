import { json } from "./responses.js";
import { sha256, ossGet, ossPut } from "./oss-store.js";
import { dispatchPush } from "./push-dispatch.js";
import { pushDeps } from "./push-deps.js";
import { sharedSecretMatches } from "./shared-secret.js";

// Re-exported for index.ts (push webhook wiring) and any legacy importers.
export { json } from "./responses.js";
export { pushDeps, pgPushDeps } from "./push-deps.js";

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
