import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeToolInputSchema } from './mcp-schema-sanitize.mjs'
import { mcpServersOption, wrapMcpServersForClaude } from './mcp-servers-claude.mjs'

const COMBINERS = ['oneOf', 'anyOf', 'allOf']

function assertNoTopLevelCombiner(schema) {
  for (const key of COMBINERS) {
    assert.ok(!(key in schema), `top-level ${key} must be removed`)
  }
}

test('top-level oneOf merges object branches into a single object schema', () => {
  const schema = sanitizeToolInputSchema({
    oneOf: [
      { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'] },
      { type: 'object', properties: { reply_token: { type: 'string' } }, required: ['reply_token'] },
    ],
  })

  assertNoTopLevelCombiner(schema)
  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.properties).sort(), ['channel', 'reply_token'])
  assert.equal(schema.required, undefined)
})

test('top-level allOf keeps merged required fields', () => {
  const schema = sanitizeToolInputSchema({
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
    ],
  })

  assertNoTopLevelCombiner(schema)
  assert.deepEqual(schema.required?.sort(), ['a', 'b'])
  assert.deepEqual(Object.keys(schema.properties).sort(), ['a', 'b'])
})

test('top-level anyOf over primitive branches becomes a generic object', () => {
  const schema = sanitizeToolInputSchema({
    anyOf: [{ type: 'string' }, { type: 'number' }],
  })

  assertNoTopLevelCombiner(schema)
  assert.equal(schema.type, 'object')
  assert.ok(schema.properties?.value)
})

test('nested combiners inside properties are flattened too', () => {
  const schema = sanitizeToolInputSchema({
    type: 'object',
    properties: {
      payload: {
        anyOf: [{ type: 'string' }, { type: 'boolean' }],
      },
    },
  })

  assertNoTopLevelCombiner(schema)
  assert.ok(schema.properties.payload)
  assert.ok(!('anyOf' in schema.properties.payload))
})

test('nullish schemas become empty object schemas', () => {
  assert.deepEqual(sanitizeToolInputSchema(null), { type: 'object', properties: {} })
  assert.deepEqual(sanitizeToolInputSchema(undefined), { type: 'object', properties: {} })
})

test('wrapMcpServersForClaude routes each server through the schema proxy', () => {
  const wrapped = wrapMcpServersForClaude({
    playwright: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { TOKEN: 'x' },
    },
  })

  const entry = wrapped.playwright
  assert.ok(entry)
  assert.equal(entry.type, 'stdio')
  assert.equal(entry.command, process.execPath)
  assert.match(entry.args[0], /mcp-schema-proxy\.mjs$/)
  assert.equal(entry.args[1], 'playwright')
  assert.deepEqual(JSON.parse(entry.args[2]), {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    env: { TOKEN: 'x' },
  })
  assert.deepEqual(entry.env, { TOKEN: 'x' })
})

test('mcpServersOption drops empty maps', () => {
  assert.deepEqual(mcpServersOption(null), {})
  assert.deepEqual(mcpServersOption({}), {})
  assert.ok(mcpServersOption({ a: { type: 'stdio', command: 'x' } }).mcpServers)
})
