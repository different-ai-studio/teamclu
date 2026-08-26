// Unit tests for MQTT topic helpers — pin the wire literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTopic } from '../src/lib/mqtt-topics.js';

test('syncTopic puts resource last: amux/<team>/sync/<resource>', () => {
  assert.equal(syncTopic('TEAM', 'knowledge'), 'amux/TEAM/sync/knowledge');
});
