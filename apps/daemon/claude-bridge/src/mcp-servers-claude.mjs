import { fileURLToPath } from 'node:url'

const PROXY_ENTRY = fileURLToPath(new URL('./mcp-schema-proxy.mjs', import.meta.url))

/**
 * Wrap workspace MCP servers so Claude Agent SDK never sees incompatible tool
 * schemas. Each upstream server becomes a local stdio proxy process.
 *
 * @param {unknown} mcpServers
 * @returns {Record<string, unknown>}
 */
export function wrapMcpServersForClaude(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return {}

  /** @type {Record<string, unknown>} */
  const wrapped = {}
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (raw.type === 'sdk' || raw.instance) {
      wrapped[name] = raw
      continue
    }
    /** @type {Record<string, string>} */
    const env = {}
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value
      }
    }
    wrapped[name] = {
      type: 'stdio',
      command: process.execPath,
      args: [PROXY_ENTRY, name, JSON.stringify(raw)],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
  }
  return wrapped
}

/**
 * @param {unknown} mcpServers
 * @returns {{ mcpServers?: Record<string, unknown> }}
 */
export function mcpServersOption(mcpServers) {
  const wrapped = wrapMcpServersForClaude(mcpServers)
  return Object.keys(wrapped).length > 0 ? { mcpServers: wrapped } : {}
}
