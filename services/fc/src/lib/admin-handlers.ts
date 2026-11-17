import { json } from "./responses.js";
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
// Intentionally thin: parse/validate the request body, then hand off to push
// dispatch (push-deps + push-dispatch). All infra lives in those modules.
//
// /register, /token, /apply and /reset-secret used to live here. They served
// the direct-to-OSS team drive (STS credentials and the `_registry/auth.json`
// team secret hash), which no longer exists — team blobs are in Supabase
// Storage and every client goes through /v1. No client called any of them.
// ---------------------------------------------------------------------------
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
