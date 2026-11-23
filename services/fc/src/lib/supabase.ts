// services/fc/src/lib/supabase.ts
//
// Thin wrapper so every module can get a service-role Supabase client without
// importing the app entry (which would create a circular dep).

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// FC runtime is Node 20, which has no native global WebSocket. supabase-js
// v2.45+ constructs a RealtimeClient inside createClient() (even when realtime
// is never used) and throws without a WebSocket transport. We never subscribe
// to channels here, but the constructor still runs — so pass `ws` to let it
// succeed (the socket is only opened lazily on an actual subscribe). Same
// workaround supabase-repo.ts already applies for the /v1 client; without it
// the /sync/* handlers (which use this service-role client) failed with
// "Node.js 20 detected without native WebSocket support".
const REALTIME_TRANSPORT_OPTS: any = { transport: WebSocket };

/**
 * Return a Supabase client authenticated as service_role.
 * Callers should NOT cache this across invocations; FC is stateless and ENV
 * may change between warm-starts in local dev.
 */
export function createServiceRoleClient() {
  const url  = process.env.SUPABASE_URL            || '';
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: "amux" }, realtime: REALTIME_TRANSPORT_OPTS,
  });
}
