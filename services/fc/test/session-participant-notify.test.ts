import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publishSessionParticipantsChanged,
  removedMemberUserId,
} from "../src/lib/session-participant-notify.js";

test("removedMemberUserId keeps a human login and drops agents", () => {
  assert.equal(removedMemberUserId({ actor_type: "member", user_id: "user-1" }), "user-1");
  assert.equal(removedMemberUserId({ actor_type: "agent", user_id: "user-agent" }), null);
  assert.equal(removedMemberUserId({ actor_type: "member", user_id: null }), null);
  assert.equal(removedMemberUserId(null), null);
});

test("publishSessionParticipantsChanged fans out the hint and includes a removed human", async () => {
  const sent: { topic: string; body: string }[] = [];
  await publishSessionParticipantsChanged({
    sessionId: "session-1",
    removedUserId: "user-removed",
    now: () => 42,
    lookup: async () => ({ teamId: "team-1", userIds: ["user-remaining", "user-remaining"] }),
    publish: async (topic, body) => { sent.push({ topic, body }); },
  });

  assert.deepEqual(sent.map((row) => row.topic).sort(), ["inbox/user-remaining", "inbox/user-removed"]);
  const payload = JSON.parse(sent[0].body);
  assert.deepEqual(payload, {
    v: 2,
    type: "session.participants",
    team_id: "team-1",
    session_id: "session-1",
    ts: 42,
  });
});

test("publishSessionParticipantsChanged still attempts every recipient when one publish fails", async () => {
  const topics: string[] = [];
  await assert.rejects(
    () => publishSessionParticipantsChanged({
      sessionId: "session-1",
      lookup: async () => ({ teamId: "team-1", userIds: ["user-a", "user-b"] }),
      publish: async (topic) => {
        topics.push(topic);
        if (topic.endsWith("user-a")) throw new Error("mqtt down");
      },
    }),
    /mqtt down/,
  );
  assert.deepEqual(topics.sort(), ["inbox/user-a", "inbox/user-b"]);
});
