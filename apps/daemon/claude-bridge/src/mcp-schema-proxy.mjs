#!/usr/bin/env node
/**
 * Stdio MCP proxy: connects to an upstream MCP server and re-exposes its tools
 * with Anthropic-compatible input schemas (no top-level oneOf/allOf/anyOf).
 *
 * Usage: node mcp-schema-proxy.mjs <label> '<upstream-json>'
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { sanitizeToolInputSchema } from './mcp-schema-sanitize.mjs'

const MAX_TOOL_PAGES = 50

/** @param {Record<string, unknown> | undefined} raw */
function resolveVars(raw) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!raw) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    out[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
      const name = a || b
      return process.env[name] ?? ''
    })
  }
  return out
}

/** @param {unknown} spec */
function parseUpstreamSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('upstream MCP config must be an object')
  }
  return /** @type {Record<string, unknown>} */ (spec)
}

/** @param {Record<string, unknown>} spec */
async function connectUpstream(spec) {
  const client = new Client({ name: 'claude-mcp-schema-proxy', version: '1.0.0' }, { capabilities: {} })
  const transportType = typeof spec.type === 'string' ? spec.type : 'stdio'

  if (transportType === 'http' || transportType === 'sse') {
    const urlValue = spec.url
    if (typeof urlValue !== 'string' || !urlValue) throw new Error('http MCP server requires url')
    const url = new URL(urlValue)
    const requestInit = { headers: resolveVars(spec.headers) }
    if (transportType === 'sse') {
      await client.connect(new SSEClientTransport(url, { requestInit }))
      return client
    }
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
    } catch (err) {
      await client.connect(new SSEClientTransport(url, { requestInit }))
      console.error(`[claude-mcp-proxy] streamable HTTP failed for ${url}; using SSE (${err})`)
    }
    return client
  }

  const command = spec.command
  if (typeof command !== 'string' || !command) {
    throw new Error('stdio MCP server requires command')
  }
  const args = Array.isArray(spec.args) ? spec.args.filter((a) => typeof a === 'string') : []
  /** @type {Record<string, string>} */
  const env = { ...process.env }
  if (spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)) {
    for (const [key, value] of Object.entries(spec.env)) {
      if (typeof value === 'string') env[key] = value
    }
  }

  await client.connect(
    new StdioClientTransport({
      command,
      args,
      env,
      stderr: 'inherit',
    }),
  )
  return client
}

/** @param {Client} client */
async function listAllTools(client) {
  /** @type {Array<Record<string, unknown>>} */
  const tools = []
  let cursor
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : {})
    for (const tool of result?.tools ?? []) {
      if (tool && typeof tool.name === 'string') tools.push(tool)
    }
    cursor = result?.nextCursor
    if (!cursor) return tools
  }
  console.error(`[claude-mcp-proxy] stopped paginating tools after ${MAX_TOOL_PAGES} pages`)
  return tools
}

/** @param {Array<Record<string, unknown>>} tools */
function sanitizeTools(tools) {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: sanitizeToolInputSchema(tool.inputSchema),
  }))
}

/** @param {string} label @param {Record<string, unknown>} upstreamSpec */
async function runProxy(label, upstreamSpec) {
  const upstream = await connectUpstream(upstreamSpec)
  let cachedTools = sanitizeTools(await listAllTools(upstream))

  upstream.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      cachedTools = sanitizeTools(await listAllTools(upstream))
    } catch (err) {
      console.error(`[claude-mcp-proxy] ${label}: tools/list_changed refresh failed (${err})`)
    }
  })

  const server = new Server(
    { name: `claude-mcp-schema-proxy:${label}`, version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cachedTools }))

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function main() {
  const label = process.argv[2] || 'upstream'
  const raw = process.argv[3]
  if (!raw) throw new Error('upstream MCP config JSON is required')
  const spec = parseUpstreamSpec(JSON.parse(raw))
  await runProxy(label, spec)
}

main().catch((err) => {
  console.error(`[claude-mcp-proxy] fatal: ${err?.message ?? err}`)
  process.exit(1)
})
