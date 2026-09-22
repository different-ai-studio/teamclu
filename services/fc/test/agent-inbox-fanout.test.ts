// Agent inbox fan-out (#1455 Phase 1).
//
// This is the agent's only delivery path: a daemon no longer subscribes to
// `session/<sid>/live` to hear inbound messages. The tests below pin the two
// properties that make that safe — it is not gated by the push idempotency
// claim, and it carries the whole row rather than a digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAgentInbox, fanoutMessage } from '../src/lib/push-dispatch.js';

function makeDeps({ agentIds = [], claim = true, lookupThrows = false, publishThrows = [] } = {}) {
  const published: { topic: string; payload: string }[] = [];
  const apnsSent: unknown[] = [];
  return {
    published,
    apnsSent,
    sb: {
      rpc(name: string) {
        if (name === 'push_idempotency_claim') {
          return Promise.resolve({ data: [{ claimed: claim }] });
        }
        if (name === 'list_session_push_targets') {
          return Promise.resolve({ data: { sender_display_name: 'Alice', recipients: [] } });
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      revokeToken: () => {},
      listSessionAgentActorIds: async (
        _sessionId: string,
        _excludeActorId: string | null,
      ): Promise<string[]> => {
        if (lookupThrows) throw new Error('boom');
        return agentIds;
      },
    },
    apns: { send: async (t: string, p: unknown) => { apnsSent.push({ t, p }); return { status: 200 }; } },
    mqtt: {
      publish: async (topic: string, payload: string) => {
        if (publishThrows.includes(topic)) throw new Error('publish failed');
        published.push({ topic, payload });
      },
    },
    now: () => new Date('2026-09-21T03:00:00Z'),
  };
}

const ROW = {
  id: 'msg-1',
  team_id: 'team-1',
  session_id: 'sess-1',
  turn_id: 'turn-1',
  sender_actor_id: 'human-1',
  reply_to_message_id: null,
  kind: 'text',
  content: '@bot hello',
  metadata: { mention_actor_ids: ['agent-1'] },
  model: null,
  created_at: '2026-09-21T02:59:00Z',
};

test('publishes one inbox message per agent participant', async () => {
  const d = makeDeps({ agentIds: ['agent-1', 'agent-2'] });
  const r = await publishAgentInbox(ROW, d);

  assert.equal(r.sent, 2);
  assert.equal(r.targets, 2);
  assert.deepEqual(d.published.map((p) => p.topic), [
    'amux/team-1/agent-1/inbox',
    'amux/team-1/agent-2/inbox',
  ]);
});

test('carries the whole row, mentions included', async () => {
  const d = makeDeps({ agentIds: ['agent-1'] });
  await publishAgentInbox(ROW, d);

  const body = JSON.parse(d.published[0].payload);
  assert.equal(body.type, 'message.created');
  assert.equal(body.v, 1);
  // The daemon routes on these two; a digest that dropped metadata would make
  // every @-mention read as an unmentioned context row.
  assert.deepEqual(body.message.metadata.mention_actor_ids, ['agent-1']);
  assert.equal(body.message.turn_id, 'turn-1');
  assert.equal(body.message.created_at, '2026-09-21T02:59:00Z');
  assert.equal(body.message.content, '@bot hello');
});

test('a claimed-duplicate push still reaches the agent inbox', async () => {
  // The claim guards APNs, not delivery. Were it to gate this path, a retried
  // dispatch would silently drop the agent's only copy of the message.
  const d = makeDeps({ agentIds: ['agent-1'], claim: false });
  const r = await fanoutMessage(ROW, d);

  assert.equal(r.skipped, 'duplicate', 'push side still short-circuits');
  assert.equal(r.agentInbox.sent, 1, 'agent inbox is published regardless');
  assert.equal(d.apnsSent.length, 0);
});

test('system messages reach nobody', async () => {
  const d = makeDeps({ agentIds: ['agent-1'] });
  const r = await publishAgentInbox({ ...ROW, kind: 'system' }, d);
  assert.equal(r.skipped, 'system_kind');
  assert.equal(d.published.length, 0);
});

test('a sender that is itself an agent is excluded by the lookup', async () => {
  // The exclusion lives in listSessionAgentActorIds; this pins that the row's
  // sender is what gets passed to it.
  let seen: unknown[] = [];
  const d = makeDeps({ agentIds: [] });
  d.sb.listSessionAgentActorIds = async (sessionId: string, exclude: string | null) => {
    seen = [sessionId, exclude];
    return [];
  };
  await publishAgentInbox({ ...ROW, sender_actor_id: 'agent-1' }, d);
  assert.deepEqual(seen, ['sess-1', 'agent-1']);
});

test('one failed publish does not hide the others', async () => {
  const d = makeDeps({
    agentIds: ['agent-1', 'agent-2'],
    publishThrows: ['amux/team-1/agent-1/inbox'],
  });
  const r = await publishAgentInbox(ROW, d);

  assert.equal(r.targets, 2);
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(d.published.map((p) => p.topic), ['amux/team-1/agent-2/inbox']);
});

test('a lookup failure is reported, not thrown', async () => {
  // insertMessage calls this fire-and-forget; throwing here would only surface
  // as an unhandled rejection.
  const d = makeDeps({ lookupThrows: true });
  const r = await publishAgentInbox(ROW, d);
  assert.equal(r.failed, 'lookup');
  assert.equal(d.published.length, 0);
});

test('no broker configured is a skip, not a crash', async () => {
  const d = makeDeps({ agentIds: ['agent-1'] });
  const r = await publishAgentInbox(ROW, { ...d, mqtt: null });
  assert.equal(r.skipped, 'no_mqtt');
});

test('member inbox ping carries team_id and message_id (B7)', async () => {
  const d = makeDeps({ agentIds: [] });
  d.sb.rpc = (name: string) => {
    if (name === 'push_idempotency_claim') return Promise.resolve({ data: [{ claimed: true }] });
    if (name === 'list_session_push_targets') {
      return Promise.resolve({
        data: {
          sender_display_name: 'Alice',
          recipients: [{ user_id: 'user-1', tokens: [], prefs: { enabled: true }, presence: [], muted: false }],
        },
      });
    }
    throw new Error(`unexpected rpc ${name}`);
  };
  await fanoutMessage(ROW, d);

  const ping = d.published.find((p) => p.topic === 'inbox/user-1');
  assert.ok(ping, 'member ping published');
  const body = JSON.parse(ping.payload);
  assert.equal(body.team_id, 'team-1');
  assert.equal(body.session_id, 'sess-1');
  assert.equal(body.message_id, 'msg-1');
  assert.equal(body.type, 'message');
});
