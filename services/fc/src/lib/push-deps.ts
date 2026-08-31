import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { REALTIME_TRANSPORT_OPTS } from './supabase-repo/shared.js';
import { createApnsJwtCache } from './apns-jwt.js';
import { createApnsClient, createHttp2Transport } from './apns.js';
import { createMqttPublisher } from './mqtt-client.js';

// ---------------------------------------------------------------------------
// Push-notification dependency wiring (APNS + MQTT + token store).
//
// Extracted from admin-handlers.ts. `dispatchPush` (push-dispatch.ts) consumes
// this dep bundle. It is lazily built and cached so the cold path stays cheap.
// ---------------------------------------------------------------------------

const SUPABASE_URL_FN       = () => process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APNS_PRIVATE_KEY_P8   = () => process.env.APNS_PRIVATE_KEY_P8 || '';
const APNS_KEY_ID           = () => process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID          = () => process.env.APNS_TEAM_ID || '';
const APNS_TOPIC            = () => process.env.APNS_TOPIC || '';
const APNS_ENV              = () => (process.env.APNS_ENV || 'production').toLowerCase();

const MQTT_BROKER_URL       = () => process.env.MQTT_BROKER_URL || '';
const MQTT_USERNAME         = () => process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD         = () => process.env.MQTT_PASSWORD || '';

function buildApns() {
  const apnsHost = APNS_ENV() === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const jwt = createApnsJwtCache({
    privateKeyP8: APNS_PRIVATE_KEY_P8(),
    keyId: APNS_KEY_ID(),
    teamId: APNS_TEAM_ID(),
  });
  return createApnsClient({
    jwt, topic: APNS_TOPIC(),
    transport: createHttp2Transport(apnsHost),
  });
}

function buildMqtt() {
  return MQTT_BROKER_URL()
    ? createMqttPublisher({
        url: MQTT_BROKER_URL(),
        username: MQTT_USERNAME(),
        password: MQTT_PASSWORD(),
      })
    : null;
}

let _pushDeps: ReturnType<typeof buildPushDeps> | null = null;
function buildPushDeps() {
  // realtime: the transport is mandatory on Node 20 — see REALTIME_TRANSPORT_OPTS.
  // Without it createClient() throws before this function ever returns, so every
  // /push/dispatch answered 500 and no notification could be sent regardless of
  // how APNS_* was configured. Every other createClient() in FC already passes it.
  const sbClient = createSupabaseClient(SUPABASE_URL_FN(), SUPABASE_SERVICE_ROLE(), {
    auth: { persistSession: false },
    // `as any`: @types/ws declares its own Event, structurally incompatible with
    // the DOM Event in RealtimeClientOptions. supabase.ts sidesteps the same
    // clash by typing its local copy `any`; the runtime value is identical.
    realtime: REALTIME_TRANSPORT_OPTS as any,
  });
  const sb = {
    rpc: (name: string, args: unknown) => sbClient.schema("amux").rpc(name, args as Record<string, unknown>),
    revokeToken: async (token: string) => {
      await sbClient.from('device_push_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token', token);
    },
  };
  return { sb, apns: buildApns(), mqtt: buildMqtt() };
}
export function pushDeps() {
  if (_pushDeps) return _pushDeps;
  _pushDeps = buildPushDeps();
  return _pushDeps;
}
