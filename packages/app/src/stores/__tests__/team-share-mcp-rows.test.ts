import { describe, expect, it } from 'vitest'
import type { TeamMcpServer } from '@/lib/backend/types'
import type { DaemonMcpServerConfig, DaemonMcpServerProbeResult } from '@/lib/daemon/daemon-local-client'
import { applyMcpProbes, mergeTeamMcpCatalogAndDaemon, planMcpItems } from '../team-share-browser'

const catalogEntry = (installed: boolean): TeamMcpServer => ({
  name: 'memory',
  description: null,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
  url: null,
  headers: null,
  env: null,
  installed,
  createdAt: null,
  updatedAt: null,
})

const workspaceOverride: DaemonMcpServerConfig = {
  source: 'workspace',
  type: 'local',
  enabled: true,
  command: ['node', './personal-memory.js'],
  environment: {},
  headers: {},
}

const builtinServer: DaemonMcpServerConfig = {
  source: 'inherent',
  type: 'local',
  enabled: true,
  command: ['amuxd', 'send-mcp'],
  environment: {},
  headers: {},
}

describe('planMcpItems', () => {
  it('does not treat a colliding personal override as a team installation', () => {
    const rows = planMcpItems([catalogEntry(false)], { memory: workspaceOverride })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'memory',
      name: 'memory',
      kind: 'team-available',
      installed: false,
      config: { source: 'team', command: ['npx', '-y', '@modelcontextprotocol/server-memory'] },
    })
    expect(rows[1]).toMatchObject({
      id: 'personal:memory',
      name: 'memory',
      kind: 'personal',
      installed: true,
      config: workspaceOverride,
    })
  })

  it('does not borrow the desktop user installation flag when a personal override wins', () => {
    const rows = planMcpItems([catalogEntry(true)], { memory: workspaceOverride })

    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      ['memory', 'team-available'],
      ['personal:memory', 'personal'],
    ])
  })

  // The (removed) Settings MCP page was the only surface that showed built-in
  // servers; this panel is the single MCP surface now, so they must appear —
  // installed, with their own kind, never mistaken for team or personal rows.
  it('shows built-in servers as their own installed kind', () => {
    const rows = planMcpItems([], { 'amuxd-send': builtinServer })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'amuxd-send',
      name: 'amuxd-send',
      kind: 'builtin',
      installed: true,
      catalog: null,
      config: { source: 'inherent' },
    })
  })

  it('keeps a colliding built-in row apart from the catalog row', () => {
    const rows = planMcpItems([catalogEntry(false)], { memory: { ...builtinServer } })

    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      ['builtin:memory', 'builtin'],
      ['memory', 'team-available'],
    ])
  })
})

describe('applyMcpProbes', () => {
  const readyProbe: DaemonMcpServerProbeResult = {
    probe_status: 'ready',
    tools: ['remember'],
    error: null,
    probed_at: '2026-08-16T00:00:00Z',
  }

  it('attributes a same-name runtime probe only to the effective personal override', () => {
    const rows = planMcpItems([catalogEntry(true)], { memory: workspaceOverride })

    const probed = applyMcpProbes(rows, { memory: readyProbe })

    expect(probed.find((row) => row.id === 'memory')).toMatchObject({
      probeStatus: 'unknown',
      tools: [],
      error: null,
    })
    expect(probed.find((row) => row.id === 'personal:memory')).toMatchObject({
      probeStatus: 'ready',
      tools: ['remember'],
      error: null,
    })
  })

  it('attributes a probe to an unshadowed team row', () => {
    const rows = planMcpItems([catalogEntry(true)], {})

    expect(applyMcpProbes(rows, { memory: readyProbe })[0]).toMatchObject({
      id: 'memory',
      probeStatus: 'ready',
      tools: ['remember'],
    })
  })

  it('attributes probes to built-in rows (they are live daemon entries)', () => {
    const rows = planMcpItems([], { 'amuxd-send': builtinServer })

    expect(applyMcpProbes(rows, { 'amuxd-send': readyProbe })[0]).toMatchObject({
      id: 'amuxd-send',
      kind: 'builtin',
      probeStatus: 'ready',
      tools: ['remember'],
    })
  })
})

describe('mergeTeamMcpCatalogAndDaemon', () => {
  it('retains the prior probe while the same MCP rows are reloaded', () => {
    const previous = applyMcpProbes(planMcpItems([catalogEntry(true)], {}), {
      memory: {
        probe_status: 'ready',
        tools: ['remember'],
        error: null,
        probed_at: '2026-08-16T00:00:00Z',
      },
    })

    expect(mergeTeamMcpCatalogAndDaemon([catalogEntry(true)], {}, previous)[0]).toMatchObject({
      probeStatus: 'ready',
      tools: ['remember'],
    })
  })
})
