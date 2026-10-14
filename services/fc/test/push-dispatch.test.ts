// services/fc/test/push-dispatch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApnsPayload, dispatchPush } from '../src/lib/push-dispatch.js';

function makeDeps({ recipients, claim = true, mqtt = null }) {
  const sent = [];
  const revoked = [];
  const published = [];
  return {
    sent, revoked, published,
    sb: {
      rpc(name, args) {
        if (name === 'push_idempotency_claim') {
          return Promise.resolve({ data: [{ claimed: claim }] });
        }
        if (name === 'list_session_push_targets') {
          return Promise.resolve({
            data: { sender_display_name: 'Alice', recipients },
          });
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      revokeToken: (t) => { revoked.push(t); },
    },
    apns: {
      send: async (token, payload) => {
        sent.push({ token, payload });
        return token.startsWith('BAD') ? { status: 410, reason: 'Unregistered' }
                                       : { status: 200 };
      },
    },
    mqtt: mqtt === 'none' ? undefined : (mqtt || {
      publish: async (topic, payload) => { published.push({ topic, payload }); },
    }),
    now: () => new Date('2026-05-17T03:00:00Z'),
  };
}

test('skips duplicate via idempotency', async () => {
  const d = makeDeps({ recipients: [], claim: false });
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(r.skipped, 'duplicate');
  assert.equal(d.sent.length, 0);
});

test('skips system kind without idempotency claim', async () => {
  const d = makeDeps({ recipients: [] });
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'system', content: '' }, d);
  assert.equal(r.skipped, 'system_kind');
});

test('drops muted recipient', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: true, prefs: { enabled: true },
    tokens: [{ provider: 'apns', token: 'GOOD1', device_id: 'D1' }],
    presence: [],
  }] });
  await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                       kind: 'text', content: 'hi' }, d);
  assert.equal(d.sent.length, 0);
});

test('drops foreground device', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: false, prefs: { enabled: true },
    tokens: [{ provider: 'apns', token: 'GOOD1', device_id: 'D1' }],
    presence: [{ device_id: 'D1', foreground_until: '2099-01-01T00:00:00Z' }],
  }] });
  await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                       kind: 'text', content: 'hi' }, d);
  assert.equal(d.sent.length, 0);
});

test('sends to active token and revokes 410', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: false, prefs: { enabled: true },
    tokens: [
      { provider: 'apns', token: 'GOOD1', device_id: 'D1' },
      { provider: 'apns', token: 'BAD2',  device_id: 'D2' },
    ],
    presence: [],
  }] });
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(d.sent.length, 2);
  assert.deepEqual(d.revoked, ['BAD2']);
  assert.equal(r.sent, 1);
  assert.equal(r.revoked, 1);
});

test('inbox: publishes one MQTT ping per non-muted recipient', async () => {
  const d = makeDeps({ recipients: [
    { user_id: 'u1', muted: false, prefs: { enabled: true },
      tokens: [{ provider: 'apns', token: 'T1', device_id: 'D1' }], presence: [] },
    { user_id: 'u2', muted: false, prefs: { enabled: true },
      tokens: [], presence: [] },
  ]});
  const r = await dispatchPush({ id: 'm1', session_id: 'sess-xyz', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(d.published.length, 2);
  const topics = d.published.map((p) => p.topic).sort();
  assert.deepEqual(topics, ['inbox/u1', 'inbox/u2']);
  const payload = JSON.parse(d.published[0].payload);
  assert.equal(payload.session_id, 'sess-xyz');
  assert.equal(typeof payload.ts, 'number');
  assert.equal(r.inboxSent, 2);
  assert.equal(r.inboxFailed, 0);
  assert.equal(r.inboxTargets, 2);
});

test('inbox: skips muted recipients but still pings foreground / DND users', async () => {
  const d = makeDeps({ recipients: [
    { user_id: 'muted', muted: true, prefs: { enabled: true },
      tokens: [{ provider: 'apns', token: 'TM', device_id: 'DM' }], presence: [] },
    { user_id: 'fg', muted: false, prefs: { enabled: true },
      tokens: [{ provider: 'apns', token: 'TF', device_id: 'DF' }],
      presence: [{ device_id: 'DF', foreground_until: '2099-01-01T00:00:00Z' }] },
  ]});
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  // muted: no APNs, no MQTT. foreground: no APNs, yes MQTT.
  assert.equal(d.sent.length, 0);
  assert.equal(d.published.length, 1);
  assert.equal(d.published[0].topic, 'inbox/fg');
});

test('inbox: deduplicates recipients by user_id', async () => {
  const d = makeDeps({ recipients: [
    { user_id: 'u1', muted: false, prefs: { enabled: true },
      tokens: [{ provider: 'apns', token: 'T1', device_id: 'D1' }], presence: [] },
    { user_id: 'u1', muted: false, prefs: { enabled: true },  // duplicate row
      tokens: [{ provider: 'apns', token: 'T2', device_id: 'D2' }], presence: [] },
  ]});
  await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                        kind: 'text', content: 'hi' }, d);
  assert.equal(d.published.length, 1);
  assert.equal(d.published[0].topic, 'inbox/u1');
});

test('inbox: backwards compatible when mqtt dep is absent', async () => {
  const d = makeDeps({ mqtt: 'none', recipients: [
    { user_id: 'u1', muted: false, prefs: { enabled: true },
      tokens: [{ provider: 'apns', token: 'T1', device_id: 'D1' }], presence: [] },
  ]});
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(d.published.length, 0);
  assert.equal(r.inboxSent, 0);
  assert.equal(r.inboxFailed, 0);
  assert.equal(r.inboxTargets, 0);
  assert.equal(r.sent, 1); // APNs still works
});

test('inbox: MQTT publish failure is counted, does not break APNs flow', async () => {
  const failingMqtt = {
    publish: async () => { throw new Error('broker unreachable'); },
  };
  const d = makeDeps({ mqtt: failingMqtt, recipients: [
    { user_id: 'u1', muted: false, prefs: { enabled: true },
      tokens: [{ provider: 'apns', token: 'GOOD', device_id: 'D1' }], presence: [] },
  ]});
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(r.sent, 1);          // APNs succeeded
  assert.equal(r.inboxSent, 0);
  assert.equal(r.inboxFailed, 1);
});

test('message push carries the reply category and what a reply needs', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: false, prefs: { enabled: true },
    tokens: [{ provider: 'apns', token: 'GOOD1', device_id: 'D1' }],
    presence: [],
  }] });
  await dispatchPush({ id: 'm1', team_id: 't1', session_id: 's', sender_actor_id: 'agent-a',
                       kind: 'text', content: 'hi' }, d);
  const { payload } = d.sent[0];
  assert.equal(payload.aps.category, 'SESSION_MESSAGE');
  assert.equal(payload.data.team_id, 't1');
  assert.equal(payload.data.sender_actor_id, 'agent-a');
  assert.equal(payload.data.message_id, 'm1');
});

test('payload without team still builds (older callers)', () => {
  const p = buildApnsPayload({ title: 'A', body: 'b', sessionId: 's', messageId: 'm' });
  assert.equal(p.data.team_id, null);
  assert.equal(p.aps.category, 'SESSION_MESSAGE');
});
