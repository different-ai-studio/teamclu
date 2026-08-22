import { create } from 'zustand'
import { useWorkspaceStore } from '@/stores/workspace'
import { useEnvVarsStore, type TeamEnvListing } from '@/stores/env-vars'
import type { SkillSource } from '@/lib/skills/types'
import { resolveTeamDir } from '@/lib/team-skill-paths'
import { invoke } from '@tauri-apps/api/core'
import { getBackend } from '@/lib/backend/provider'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { ensureAgentsSkillsPaths } from '@/lib/skills/ensure-agents-paths'
import {
  planReconcile,
  planVersionWriteback,
  type OnDiskSkill,
  type SkillLocalState,
} from '@/lib/skills/auto-follow'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTabsStore } from '@/stores/tabs'
import {
  decodeTeamShareTarget,
  encodeTeamShareTarget,
  teamShareSectionForTarget,
  type TeamShareTarget,
} from '@/lib/tabs/teamshare-target'
import { TEAM_REPO_DIR } from '@/lib/build-config'

function closeTeamShareTabs(match: (target: string) => boolean): void {
  const { tabs, closeTab } = useTabsStore.getState()
  for (const tab of tabs) {
    if (tab.type === 'native' && match(tab.target)) closeTab(tab.id)
  }
}

/**
 * Every tab showing this skill: its detail, and any file of its package.
 *
 * A row's id is not always its slug — a personal skill whose name the registry
 * also owns is addressed as `personal:<slug>` — so both spellings are closed.
 * Leaving one open would leave a tab pointed at a skill that no longer exists.
 */
function closeSkillTabs(slug: string): void {
  const ids = [slug, `personal:${slug}`]
  const detail = useTeamShareBrowserStore.getState().detailTarget
  if (
    detail &&
    (detail.kind === 'skill' || detail.kind === 'skill-file') &&
    ids.includes(detail.id)
  ) {
    useTeamShareBrowserStore.setState({ detailTarget: null })
  }
  closeTeamShareTabs((target) => {
    const t = decodeTeamShareTarget(target)
    if (!t) return false
    return (t.kind === 'skill' || t.kind === 'skill-file') && ids.includes(t.id)
  })
}

/** `knowledge/` may not exist yet on a freshly enabled team. */
async function ensureDir(path: string): Promise<void> {
  try {
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    await mkdir(path, { recursive: true })
  } catch {
    // Already there, or no FS access — the tree just renders empty.
  }
}
import type {
  TeamSkill,
  TeamSkillCategory,
  TeamSkillStatus,
} from '@/lib/backend/cloud-api/team-skills'
import type { TeamMcpServer, TeamMcpServerWrite } from '@/lib/backend/cloud-api/team-mcp'
import {
  encodeWorkspaceId,
  getDaemonMcp,
  getDaemonMcpTools,
  putDaemonMcp,
  installDaemonTeamMcp,
  reconcileDaemonTeamCloudConfig,
  type DaemonMcpServerConfig,
  type DaemonMcpServerProbeResult,
} from '@/lib/daemon-local-client'
import { SKILLS_CHANGED_EVENT } from '@/hooks/useAppInit'
import { AgentCapabilityAction, AgentCapabilityKind } from '@/lib/proto/teamclu_pb'
import { manageAgentCapability } from '@/lib/teamclu-rpc'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'

function requireAgentOnline(actorId: string): void {
  if (resolveAgentDevicePresenceSync(actorId) === 'offline') {
    throw new Error('Agent 离线，不能执行管理操作')
  }
}

function agentManagementError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /timeout|timed out|unexpected result variant|agent_management_unsupported/i.test(message)
    ? '此 Agent 的 amuxd 不支持能力管理，请升级 Agent 后重试'
    : message
}

/** The four browsable team-shared content kinds. */
export type TeamShareSection = 'skills' | 'mcp' | 'env' | 'knowledge'

export const TEAM_SHARE_SECTIONS: TeamShareSection[] = ['skills', 'mcp', 'env', 'knowledge']

export type TeamSkillKind = 'team-available' | 'team-installed' | 'personal'

export type TeamMcpKind = 'team-available' | 'team-installed' | 'personal' | 'builtin'

/**
 * A row in the unified skills list.
 *
 * - `team-available` / `team-installed` — Cloud API registry
 * - `personal` — skill-loader union (opencode / claude / agents / …), excluding
 *   slugs already owned by the registry
 */
export interface TeamSkillItem {
  /**
   * Row identity for selection. Equal to `slug` except for a personal skill
   * whose name the registry also owns, which gets `personal:<slug>` so both
   * rows remain openable.
   */
  id: string
  /** Directory name / slug (used as the daemon skill id). */
  slug: string
  name: string
  invocationName: string
  category: string | null
  content: string
  dirPath: string
  filename: string
  origin: 'registry' | 'legacy' | 'personal'
  kind: TeamSkillKind
  /** skill-loader source for personal rows (for meta badge). */
  personalSource: SkillSource | null
  personalSourceLabel: string | null
  summary: string | null
  whenToUse: string | null
  whenNotToUse: string | null
  requires: string[] | null
  status: TeamSkillStatus | null
  supersededBy: string | null
  ownerActorId: string | null
  latestVersion: number | null
  installed: boolean
  installedVersion: number | null
  hasUpdate: boolean
  createdAt: string | null
  updatedAt: string | null
  /** Marketplace provenance (API `origin` / subscription flags). */
  marketplaceOrigin?: 'local' | 'marketplace'
  upstreamSlug?: string | null
  upstreamSubscribed?: boolean
  upstreamDetachedAt?: string | null
}

export interface TeamMcpItem {
  /** Row identity. Personal overrides use `personal:<name>` on collisions. */
  id: string
  name: string
  config: DaemonMcpServerConfig
  probeStatus: DaemonMcpServerProbeResult['probe_status'] | 'unknown'
  tools: string[]
  error: string | null
  kind: TeamMcpKind
  /**
   * The catalog row, when this server came from the Cloud API. `null` for a
   * personal / legacy entry that only exists on this machine.
   */
  catalog: TeamMcpServer | null
  /** Whether this machine's daemon actor has installed it. Uninstalled servers do not run. */
  installed: boolean
}

export interface TeamKnowledgeItem {
  path: string
  relPath: string
  name: string
}

export interface TeamSkillShareInput {
  slug: string
  summary: string
  category: TeamSkillCategory
  whenToUse: string
  whenNotToUse: string
  changelog: string
  requires?: string[] | null
}

type SectionState<T> = {
  items: T[]
  loading: boolean
  loaded: boolean
  error: string | null
}

const emptySection = <T>(): SectionState<T> => ({ items: [], loading: false, loaded: false, error: null })

interface TeamShareBrowserState {
  skills: SectionState<TeamSkillItem>
  mcp: SectionState<TeamMcpItem>
  knowledge: SectionState<TeamKnowledgeItem>
  envCount: number
  /** Absolute path of the team shared root, for the knowledge file tree. */
  knowledgeRoot: string | null
  subjectActorId: string | null
  /** Single detail shown beside the list. Team-share items never create tabs. */
  detailTarget: TeamShareTarget | null

  counts: () => Record<TeamShareSection, number>
  /** Show one section item in the direct detail pane. Knowledge keeps file tabs. */
  select: (section: TeamShareSection, id: string | null) => void
  /** Replace the detail pane with one file of a skill package. */
  selectSkillFile: (id: string, rel: string) => void
  /** Clear a removed package file from the detail pane and any legacy tabs. */
  closeSkillFiles: (id: string, rel: string) => void
  setCreating: (section: TeamShareSection | null) => void
  clearDetail: () => void
  /** Open a direct detail target (marketplace browse, etc.). */
  openDetail: (target: TeamShareTarget) => void
  /** Adopt a marketplace catalog entry, then install it for the caller. */
  adoptMarketplaceSkill: (marketplaceSlug: string, opts?: { slug?: string }) => Promise<void>
  detachMarketplaceSkill: (slug: string) => Promise<void>
  setSubjectActor: (actorId: string | null) => Promise<void>
  installSkill: (slug: string) => Promise<void>
  uninstallSkill: (slug: string) => Promise<void>
  /** Remove a personal skill directory from disk (not a team-registry delete). */
  deletePersonalSkill: (slug: string) => Promise<void>
  /** Install a team MCP server for yourself — there is no install-for-others. */
  installMcp: (name: string) => Promise<void>
  uninstallMcp: (name: string) => Promise<void>
  createMcp: (input: TeamMcpServerWrite) => Promise<void>
  updateMcp: (name: string, patch: TeamMcpServerWrite) => Promise<void>
  deleteMcp: (name: string) => Promise<void>
  /** Add a server to this workspace only (the daemon's merged map, source `workspace`). */
  createPersonalMcp: (input: TeamMcpServerWrite) => Promise<void>
  /** Rewrite a personal or built-in entry in the daemon's workspace map. */
  updateWorkspaceMcp: (id: string, patch: TeamMcpServerWrite) => Promise<void>
  /** Enable/disable a personal or built-in entry (team servers have no local toggle). */
  toggleMcp: (id: string, enabled: boolean) => Promise<void>
  /** Publish a personal MCP into the team catalog and install it for yourself. */
  sharePersonalMcp: (name: string, input?: Pick<TeamMcpServerWrite, 'description'>) => Promise<void>
  /** Copy-publish a personal skill to the team registry, then auto-install. */
  /** Returns where the personal original was retired to, if it was. */
  sharePersonalSkill: (slug: string, input: TeamSkillShareInput) => Promise<string | null>
  /** Publish the local edits of an already-shared skill as the next version. */
  publishSkillVersion: (slug: string, input: TeamSkillVersionInput) => Promise<void>
  /**
   * Disk state per slug, from `team_skill_inspect`. Empty until a reconcile
   * runs; a slug missing from here means "not checked yet", which the UI shows
   * as nothing rather than as clean.
   */
  skillLocalState: Record<string, SkillLocalState>
  /**
   * Why a slug failed to sync, per slug. Auto-follow has no button to click, so
   * a download that keeps failing would otherwise be indistinguishable from one
   * that has not happened yet.
   */
  skillSyncErrors: Record<string, string>
  /**
   * Slug → where an unrelated directory was moved when auto-follow needed its
   * path. Offered back to the user under a new name; see `keepArchivedCopy`.
   */
  skillArchived: Record<string, string>
  /** Restore an archived directory under `newSlug`, keeping the team pack. */
  keepArchivedCopy: (slug: string, newSlug: string) => Promise<void>
  dismissArchived: (slug: string) => void
  /**
   * Bring disk in line with the server's desired state. Runs on a timer, on
   * panel open, and after any local mutation.
   */
  reconcileSkills: () => Promise<void>
  /** Publish an older version's content as the new latest (undo a bad publish). */
  revertSkillVersion: (slug: string, version: number) => Promise<void>
  /** Move the edited pack aside and re-install clean. Returns the undo handle. */
  discardLocalSkill: (slug: string) => Promise<string>
  restoreDiscardedSkill: (trashedPath: string, slug: string) => Promise<void>
  /** Copy the edits out under a new slug so the team version can keep following. */
  forkSkill: (slug: string, newSlug: string) => Promise<string>
  loadSkillDiff: (slug: string) => Promise<TeamSkillFileDiff[]>
  loadSection: (section: TeamShareSection, opts?: { force?: boolean; withTools?: boolean }) => Promise<void>
  loadMcpTools: (opts?: { refresh?: boolean }) => Promise<void>
  loadCounts: () => Promise<void>
}

export interface TeamSkillVersionInput {
  changelog: string
  summary?: string
  category?: TeamSkillCategory
  whenToUse?: string
  whenNotToUse?: string
  requires?: string[] | null
}

export interface TeamSkillFileDiff {
  path: string
  baseline: string | null
  current: string | null
  binary: boolean
}

function workspacePath(): string | null {
  return useWorkspaceStore.getState().workspacePath
}

function currentTeamId(): string | null {
  return useCurrentTeamStore.getState().team?.id ?? null
}

/**
 * The entries directly under `knowledge/` — the same rows the column's file
 * tree shows at its root.
 *
 * This listing exists only to produce the header and nav counts, so it has to
 * agree with what sits next to those counts, the way every other section's does.
 * It previously walked the tree recursively and counted only `md/mdx/markdown/
 * txt`, which disagreed twice over: a folder was visible but never counted, and
 * any other file type — a PDF, an image — was shared by sync yet invisible to
 * the count.
 */
async function listTeamKnowledge(wsPath: string): Promise<TeamKnowledgeItem[]> {
  const teamDir = await resolveTeamDir(wsPath)
  if (!teamDir) return []
  const knowledgeDir = `${teamDir}/knowledge`
  const { exists, readDir } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(knowledgeDir))) return []

  const entries = await readDir(knowledgeDir)
  // Dotfiles are deliberately not filtered: the tree renders them, so counting
  // them is what keeps the two numbers equal.
  return entries
    .map((entry) => ({
      path: `${knowledgeDir}/${entry.name}`,
      relPath: entry.name,
      name: entry.name,
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
}

type OnDisk = { content: string; dirPath: string; invocationName: string; source: SkillSource }

function registryItem(
  skill: TeamSkill,
  onDisk: Map<string, OnDisk>,
  kind: 'team-available' | 'team-installed',
  /** True when a real team pack for this slug is on disk. */
  packOnDisk: boolean,
): TeamSkillItem {
  // Only borrow the on-disk copy when it is actually the pack. A file that
  // merely shares the name — a personal skill the user dropped into the pack
  // root, or one living in a higher-priority root — is a different skill, and
  // showing its contents under the registry row made an uninstalled team skill
  // display something the team never published. That file gets its own personal
  // row instead; this row shows what the registry knows and nothing more.
  const local = packOnDisk ? onDisk.get(skill.slug) : undefined
  return {
    id: skill.slug,
    slug: skill.slug,
    name: skill.slug,
    invocationName: local?.invocationName ?? skill.slug,
    category: skill.category,
    content: local?.content ?? '',
    dirPath: local?.dirPath ?? '',
    filename: skill.slug,
    origin: 'registry',
    kind,
    personalSource: null,
    personalSourceLabel: null,
    summary: skill.summary,
    whenToUse: skill.whenToUse,
    whenNotToUse: skill.whenNotToUse,
    requires: skill.requires,
    status: skill.status,
    supersededBy: skill.supersededBy,
    ownerActorId: skill.ownerActorId,
    latestVersion: skill.latestVersion,
    installed: skill.installed,
    installedVersion: skill.installedVersion,
    hasUpdate: skill.hasUpdate,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    marketplaceOrigin: skill.origin ?? 'local',
    upstreamSlug: skill.upstreamSlug ?? null,
    upstreamSubscribed: skill.upstreamSubscribed ?? false,
    upstreamDetachedAt: skill.upstreamDetachedAt ?? null,
  }
}

/**
 * Whether a skill-loader row still deserves a "personal" row of its own, and
 * under what id.
 *
 * Hidden only when the row *is* the team pack the registry row already stands
 * for — a pack on disk, found under the pack root. A file that merely shares
 * the pack's name is a different skill: it still loads, agents still see it,
 * and on most machines it is the one shadowing the pack. Hiding those (which is
 * what matching on the slug alone did) removed the one place a member could see
 * the collision — and did it whether or not they had ever installed the team
 * version, so publishing `deploy-check` made every teammate's private
 * `deploy-check` disappear from the list while it kept running underneath.
 */
export function planPersonalRow(row: {
  slug: string
  source: SkillSource
  registryOwnsSlug: boolean
  packOnDisk: boolean
}): { hidden: boolean; id: string } {
  if (row.registryOwnsSlug && row.packOnDisk && row.source === 'global-agent') {
    return { hidden: true, id: row.slug }
  }
  // Builtin / clawhub market copies are not "my personal skills".
  if (row.source === 'builtin' || row.source === 'clawhub') {
    return { hidden: true, id: row.slug }
  }
  // Rows are selected by id and resolved by first match, so a colliding row
  // needs its own or only the registry one can ever be opened.
  return { hidden: false, id: row.registryOwnsSlug ? `personal:${row.slug}` : row.slug }
}

/**
 * Three buckets:
 * 1. registry installed → team-installed
 * 2. registry not installed → team-available (hides personal twin)
 * 3. skill-loader rows whose slug is not in the registry → personal
 *
 * Legacy wholesale `source: team` dirs are only kept as personal when the
 * registry does not already own that slug (migration period).
 */
async function listTeamSkills(
  _wsPath: string | null,
  teamId: string | null,
  actorId?: string,
): Promise<{ items: TeamSkillItem[]; registryError: string | null }> {
  // Agent management is intentionally all-or-nothing: without an explicit
  // target there is no "current machine" fallback, because that would make a
  // remote Agent page silently show the desktop user's filesystem.
  if (!teamId || !actorId) return { items: [], registryError: null }
  try {
    const backend = getBackend()
    const [registry, grant] = await Promise.all([
      backend.teamSkills.listTeamSkills(teamId, { actorId }),
      backend.actors.createAgentManagementGrant(actorId, ['skills:list']),
    ])
    const result = await manageAgentCapability({
      targetActorId: actorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_SKILL,
      action: AgentCapabilityAction.LIST_INVENTORY,
    })
    const bySlug = new Map(registry.map((skill) => [skill.slug, skill]))
    const items = result.skills.map((inventory): TeamSkillItem => {
      const skill = bySlug.get(inventory.id)
      if (inventory.teamItem && skill) {
        return {
          ...registryItem(skill, new Map(), 'team-installed', inventory.health === 'installed'),
          installed: inventory.health === 'installed',
          installedVersion: Number(inventory.version) || null,
          hasUpdate: inventory.health !== 'installed',
        }
      }
      const slug = inventory.id.replace(/^personal:/, '')
      return {
        id: inventory.id,
        slug,
        name: inventory.name || slug,
        invocationName: slug,
        category: null,
        content: '',
        dirPath: '',
        filename: slug,
        origin: 'personal',
        kind: 'personal',
        personalSource: inventory.source === 'builtin' ? 'builtin' : 'global-agent',
        personalSourceLabel: inventory.source === 'builtin' ? '内置' : 'Agent',
        summary: null,
        whenToUse: null,
        whenNotToUse: null,
        requires: null,
        status: null,
        supersededBy: null,
        ownerActorId: null,
        latestVersion: null,
        installed: true,
        installedVersion: Number(inventory.version) || null,
        hasUpdate: inventory.health !== 'installed',
        createdAt: null,
        updatedAt: null,
      }
    })
    items.sort((a, b) => a.name.localeCompare(b.name))
    return { items, registryError: null }
  } catch (e) {
    return { items: [], registryError: agentManagementError(e) }
  }

}

/**
 * Two sources, deliberately unioned rather than one replacing the other.
 *
 * The Cloud API catalog is the full list of what the team offers — including
 * servers you have NOT installed, which is the point of a catalog and which the
 * daemon therefore knows nothing about. The daemon's view is what is actually
 * wired into this workspace right now, and is the only source of live probe
 * state (connected / tools / errors).
 *
 * A legacy server that exists only as a synced `.mcp/*.json` file shows up from
 * the daemon side with no catalog row; it stays read-only and is reported as
 * installed, because for those the two concepts never separated.
 */
export function mergeTeamMcpCatalogAndDaemon(
  catalog: TeamMcpServer[],
  daemonConfig: Record<string, DaemonMcpServerConfig>,
  previousItems: TeamMcpItem[] = [],
): TeamMcpItem[] {
  return preserveMcpProbes(planMcpItems(catalog, daemonConfig), previousItems)
}

/**
 * Catalog/config refresh creates fresh rows, while probing is asynchronous.
 * Keep the last known probe for a surviving row so switching sections does not
 * briefly repaint it as "0 tools" before the daemon's cached probe returns.
 */
export function preserveMcpProbes(items: TeamMcpItem[], previousItems: TeamMcpItem[]): TeamMcpItem[] {
  const previousById = new Map(previousItems.map((item) => [item.id, item]))
  return items.map((item) => {
    const previous = previousById.get(item.id)
    if (!previous) return item
    return {
      ...item,
      probeStatus: previous.probeStatus,
      tools: previous.tools,
      error: previous.error,
    }
  })
}

/**
 * Keep Cloud catalog identity separate from workspace-owned configuration.
 * A same-name local override still runs with workspace precedence, but it must
 * never make an uninstalled team row look installed or become deletion fodder
 * for a team uninstall.
 */
export function planMcpItems(
  catalog: TeamMcpServer[],
  daemonConfig: Record<string, DaemonMcpServerConfig>,
): TeamMcpItem[] {
  const items: TeamMcpItem[] = []
  const catalogNames = new Set(catalog.map((entry) => entry.name))

  for (const entry of catalog) {
    const live = daemonConfig[entry.name]
    const installed = live?.source === 'team'
    items.push({
      id: entry.name,
      name: entry.name,
      config: installed ? live : catalogToDaemonConfig(entry),
      probeStatus: 'unknown',
      tools: [],
      error: null,
      kind: installed ? 'team-installed' : 'team-available',
      catalog: entry,
      // The catalog is fetched with the desktop user's token, while install
      // mutations target the daemon actor. Only the daemon's live merged config
      // can answer whether this machine will actually run the server.
      installed,
    })
  }

  // Daemon-only rows: built-ins, legacy team entries, workspace custom not in
  // the catalog, plus independently selectable workspace overrides on catalog
  // collisions. Built-ins used to be filtered out here and lived only in the
  // (since removed) Settings MCP page — this panel is now the one MCP surface,
  // so they show as a read-only kind of their own.
  for (const [name, cfg] of Object.entries(daemonConfig)) {
    const collides = catalogNames.has(name)
    if (collides && cfg.source === 'team') continue
    const kind: TeamMcpKind =
      cfg.source === 'inherent' ? 'builtin' : cfg.source !== 'team' ? 'personal' : 'team-installed'
    items.push({
      id: collides ? `${kind === 'builtin' ? 'builtin' : 'personal'}:${name}` : name,
      name,
      config: cfg,
      probeStatus: 'unknown',
      tools: [],
      error: null,
      kind,
      catalog: null,
      installed: true,
    })
  }

  return items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/**
 * A daemon probe describes the server that actually wins workspace resolution.
 * When a workspace override shadows a same-name catalog entry, attaching that
 * probe to both rows would make the dormant team definition look connected.
 */
export function applyMcpProbes(
  items: TeamMcpItem[],
  probes: Record<string, DaemonMcpServerProbeResult>,
): TeamMcpItem[] {
  const locallyOverridden = new Set(
    items
      .filter((item) => item.kind === 'personal' || item.kind === 'builtin')
      .map((item) => item.name),
  )

  return items.map((item) => {
    if (
      item.kind !== 'personal' &&
      item.kind !== 'builtin' &&
      locallyOverridden.has(item.name)
    )
      return item
    const probe = probes[item.name]
    return probe
      ? { ...item, probeStatus: probe.probe_status, tools: probe.tools, error: probe.error }
      : item
  })
}

async function listTeamMcp(
  wsPath: string,
  teamId: string | null,
  previousItems: TeamMcpItem[] = [],
  actorId?: string,
): Promise<TeamMcpItem[]> {
  if (teamId && actorId) {
    const backend = getBackend()
    const [catalog, grant] = await Promise.all([
      backend.teamMcp.listTeamMcpServers(teamId).catch(() => []),
      backend.actors.createAgentManagementGrant(actorId, ['mcp:list']),
    ])
    const result = await manageAgentCapability({
      targetActorId: actorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_MCP,
      action: AgentCapabilityAction.LIST_INVENTORY,
    })
    const actual = Object.fromEntries(
      result.mcpServers.map((item) => [item.id, {
        type: item.transport === 'http' ? 'remote' : 'local',
        source: item.source === 'team' ? 'team' : item.source === 'builtin' ? 'inherent' : 'workspace',
        enabled: item.configStatus === 'installed',
        ...(item.transport === 'http'
          ? { url: item.commandOrUrl }
          : { command: item.commandOrUrl ? item.commandOrUrl.split(' ') : [] }),
        environment: Object.fromEntries(item.configuredEnvKeys.map((key) => [key, ''])),
        headers: Object.fromEntries(item.configuredHeaderKeys.map((key) => [key, ''])),
      } satisfies DaemonMcpServerConfig]),
    )
    return mergeTeamMcpCatalogAndDaemon(catalog, actual, previousItems)
      .filter((item) => item.installed)
  }
  if (!actorId) return []
  const wid = encodeWorkspaceId(wsPath)
  const daemonConfig = await getDaemonMcp(wid).catch(() => ({}) as Record<string, DaemonMcpServerConfig>)

  let catalog: TeamMcpServer[] = []
  if (teamId) {
    catalog = await getBackend()
      .teamMcp.listTeamMcpServers(teamId)
      // A catalog fetch failure must not blank the servers already running —
      // fall back to the daemon's view rather than showing an empty team.
      .catch(() => [])
  }
  return mergeTeamMcpCatalogAndDaemon(catalog, daemonConfig, previousItems)
}

/** Raised by the Rust installer instead of overwriting a locally edited pack. */
const DIRTY_CONFLICT_ERROR = 'team_skill_dirty_conflict'

/**
 * A contract string, not a message — the UI has to recognise it to show the
 * conflict flow rather than surfacing "team_skill_dirty_conflict" in a toast.
 */
export function isSkillDirtyConflict(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).includes(DIRTY_CONFLICT_ERROR)
}

const isDirtyConflict = isSkillDirtyConflict

/** The team registry already has this name. Raised before any upload happens. */
export class SkillSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`${slug} already exists in the team registry`)
    this.name = 'SkillSlugTakenError'
  }
}

/**
 * The local edits were moved aside, but the clean copy did not land.
 *
 * Carries the backup path because that is the whole difference between a
 * recoverable failure and a silent loss: without it the UI has a red toast and
 * no way to offer the undo, while the user's work sits in a hidden directory
 * they will never find. The reconcile tick puts the team's copy back on its
 * own, so this is the only part that needs a person.
 */
export class SkillDiscardIncompleteError extends Error {
  constructor(
    readonly trashedPath: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'SkillDiscardIncompleteError'
  }
}

/**
 * Download one version and lay it down.
 *
 * Split out of `installSkill` because the reconcile loop needs these steps
 * without the half that records a choice on the server: auto-follow is not a
 * new decision, it is carrying out the one the user already made.
 */
async function materializeSkill(
  teamId: string,
  slug: string,
  version: number,
  opts: { force?: boolean; archiveUnmanaged?: boolean } = {},
): Promise<{ archivedPath?: string }> {
  const backend = getBackend()
  const wsPath = workspacePath()
  const detail = await backend.teamSkills.getTeamSkill(teamId, slug)
  const { url } = await backend.teamSkills.resolveDownload(teamId, slug, version)
  // Download URLs are storage-presigned (S3/MinIO/Supabase). Passing a Bearer
  // JWT makes MinIO answer 400 "multiple authentication types" and is what
  // made marketplace auto-follow stuck on "Update failed — retry".
  const result = await invoke<{ archivedPath?: string }>('team_skill_install', {
    request: {
      workspacePath: wsPath,
      slug,
      teamId,
      downloadUrl: url,
      accessToken: null,
      version,
      owner: detail.ownerActorId,
      category: detail.category,
      summary: detail.summary,
      whenToUse: detail.whenToUse,
      whenNotToUse: detail.whenNotToUse,
      requires: detail.requires,
      isGlobal: true,
      force: opts.force ?? false,
      archiveUnmanaged: opts.archiveUnmanaged ?? false,
    },
  })
  await ensureAgentsSkillsPaths(wsPath)
  return result ?? {}
}

async function inspectSkill(
  slug: string,
  expectedVersion: number | null,
  teamId: string,
): Promise<SkillLocalState> {
  return invoke<SkillLocalState>('team_skill_inspect', { slug, expectedVersion, teamId })
}

async function listInstalledPacks(): Promise<OnDiskSkill[]> {
  return invoke<OnDiskSkill[]>('team_skill_list_installed')
}

/** Render a catalog row in the daemon's config shape so one detail view serves both. */
function catalogToDaemonConfig(entry: TeamMcpServer): DaemonMcpServerConfig {
  const base = {
    source: 'team' as const,
    enabled: true,
    environment: entry.env ?? {},
  }
  return entry.transport === 'remote'
    ? ({ ...base, type: 'remote', url: entry.url ?? undefined, headers: entry.headers ?? {} } as DaemonMcpServerConfig)
    : ({
        ...base,
        type: 'local',
        command: [entry.command ?? '', ...(entry.args ?? [])].filter(Boolean),
        headers: {},
      } as DaemonMcpServerConfig)
}

/**
 * Form input → the daemon's workspace-map entry shape. `prev` keeps fields the
 * form does not own (source, enabled, timeout, unknown extras) so editing a
 * built-in preserves its `source: 'inherent'` identity, and re-saving never
 * silently re-enables a disabled server. Fields of the OTHER transport are
 * cleared explicitly — a local→remote switch must not leave a stale command.
 */
function writeToDaemonConfig(
  input: TeamMcpServerWrite,
  prev?: DaemonMcpServerConfig,
): DaemonMcpServerConfig {
  const base: DaemonMcpServerConfig = {
    ...(prev ?? {}),
    enabled: prev?.enabled ?? true,
    environment: input.env ?? {},
  }
  if (input.transport === 'remote') {
    return {
      ...base,
      type: 'remote',
      url: input.url ?? undefined,
      headers: input.headers ?? {},
      command: undefined,
    }
  }
  return {
    ...base,
    type: 'local',
    command: [input.command ?? '', ...(input.args ?? [])].filter(Boolean),
    url: undefined,
    headers: {},
  }
}

function daemonConfigToCatalogWrite(
  name: string,
  cfg: DaemonMcpServerConfig,
): TeamMcpServerWrite {
  const env =
    cfg.environment && Object.keys(cfg.environment).length ? cfg.environment : null
  if (cfg.type === 'remote' || (Boolean(cfg.url) && cfg.type !== 'local')) {
    return {
      name,
      transport: 'remote',
      url: cfg.url ?? null,
      headers: cfg.headers ?? null,
      env,
      command: null,
      args: null,
    }
  }
  const parts = (cfg.command ?? []).filter(Boolean)
  return {
    name,
    transport: 'local',
    command: parts[0] ?? '',
    args: parts.slice(1),
    url: null,
    headers: null,
    env,
  }
}

export const useTeamShareBrowserStore = create<TeamShareBrowserState>((set, get) => ({
  skills: emptySection<TeamSkillItem>(),
  mcp: emptySection<TeamMcpItem>(),
  knowledge: emptySection<TeamKnowledgeItem>(),
  envCount: 0,
  knowledgeRoot: null,
  subjectActorId: null,
  detailTarget: null,
  skillLocalState: {},
  skillSyncErrors: {},
  skillArchived: {},

  counts: () => {
    const s = get()
    return {
      skills: s.skills.items.length,
      mcp: s.mcp.items.length,
      env: s.envCount,
      knowledge: s.knowledge.items.length,
    }
  },

  select: (section, id) => {
    if (section === 'knowledge') return // documents are plain file tabs
    if (!id) {
      // Only clear/replace a detail owned by this section. Deselecting a skill
      // falls back to the marketplace instead of blanking the main column.
      if (teamShareSectionForTarget(get().detailTarget) !== section) return
      if (section === 'skills') {
        set({ detailTarget: { kind: 'marketplace' } })
        return
      }
      set({ detailTarget: null })
      return
    }
    set({
      detailTarget:
        section === 'mcp'
          ? { kind: 'mcp', name: id }
          : section === 'env'
            ? { kind: 'env', keyId: id }
            : { kind: 'skill', id },
    })
  },

  selectSkillFile: (id, rel) => {
    set({ detailTarget: { kind: 'skill-file', id, rel } })
  },

  closeSkillFiles: (id, rel) => {
    const detail = get().detailTarget
    if (
      detail?.kind === 'skill-file' &&
      detail.id === id &&
      (detail.rel === rel || detail.rel.startsWith(`${rel}/`))
    ) {
      set({ detailTarget: null })
    }
    // Clean up tabs persisted by older builds.
    closeTeamShareTabs((target) => {
      const t = decodeTeamShareTarget(target)
      if (t?.kind !== 'skill-file' || t.id !== id) return false
      return t.rel === rel || t.rel.startsWith(`${rel}/`)
    })
  },

  setCreating: (section) => {
    if (section !== 'mcp' && section !== 'env') return
    set({ detailTarget: { kind: 'create', section } })
  },

  clearDetail: () => set({ detailTarget: null }),

  openDetail: (target) => set({ detailTarget: target }),

  adoptMarketplaceSkill: async (marketplaceSlug, opts = {}) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) throw new Error('no team')
    const backend = getBackend()
    await backend.marketplace.adoptTeamSkill(teamId, {
      marketplaceSlug,
      slug: opts.slug,
    })
    // Stay on the marketplace list (or whatever pane is open). MarketplacePane
    // refreshes its own catalog after adopt; jumping to skill detail felt like
    // the main column "navigated away" from Add to team.
    await get().loadSection('skills', { force: true })
  },

  detachMarketplaceSkill: async (slug) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) throw new Error('no team')
    await getBackend().marketplace.detachTeamSkill(teamId, slug)
    await get().loadSection('skills', { force: true })
  },

  setSubjectActor: async (actorId) => {
    set({ subjectActorId: actorId, detailTarget: null })
    await Promise.all([
      get().loadSection('skills', { force: true }),
      get().loadSection('mcp', { force: true }),
    ])
  },

  installSkill: async (slug) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const subjectActorId = get().subjectActorId
    if (!subjectActorId) throw new Error('请先选择 Agent')
    requireAgentOnline(subjectActorId)

    const listed = get().skills.items.find((s) => s.slug === slug && s.origin === 'registry')
    const catalog = listed
      ? null
      : (await getBackend().teamSkills.listTeamSkills(teamId, { actorId: subjectActorId }))
          .find((item) => item.slug === slug)
    if (!listed && !catalog) throw new Error(`${slug} is not a registry skill`)
    const version = listed?.latestVersion ?? catalog?.latestVersion ?? 1
    const grant = await getBackend().actors.createAgentManagementGrant(subjectActorId, ['skills:install'])
    await manageAgentCapability({
      targetActorId: subjectActorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_SKILL,
      action: AgentCapabilityAction.INSTALL_TEAM_ITEM,
      itemId: slug,
      version,
    })
    await get().loadSection('skills', { force: true })
  },

  uninstallSkill: async (slug) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const subjectActorId = get().subjectActorId
    if (!subjectActorId) throw new Error('请先选择 Agent')
    requireAgentOnline(subjectActorId)
    const grant = await getBackend().actors.createAgentManagementGrant(subjectActorId, ['skills:uninstall'])
    await manageAgentCapability({
      targetActorId: subjectActorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_SKILL,
      action: AgentCapabilityAction.UNINSTALL_TEAM_ITEM,
      itemId: slug,
    })
    closeSkillTabs(slug)
    await get().loadSection('skills', { force: true })
  },

  deletePersonalSkill: async (slug) => {
    const subjectActorId = get().subjectActorId
    if (!subjectActorId) throw new Error('请先选择 Agent')
    requireAgentOnline(subjectActorId)
    const skill = get().skills.items.find((s) => s.slug === slug)
    if (!skill || skill.kind !== 'personal') {
      throw new Error(`${slug} is not a personal skill`)
    }
    const grant = await getBackend().actors.createAgentManagementGrant(subjectActorId, ['skills:remove-personal'])
    await manageAgentCapability({
      targetActorId: subjectActorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_SKILL,
      action: AgentCapabilityAction.REMOVE_PERSONAL_SKILL,
      itemId: skill.id.startsWith('personal:') ? skill.id : `personal:${skill.slug}`,
    })

    closeSkillTabs(slug)
    await get().loadSection('skills', { force: true })
    window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
  },

  installMcp: async (name) => {
    const actorId = get().subjectActorId
    if (!actorId) throw new Error('请先选择 Agent')
    requireAgentOnline(actorId)
    const grant = await getBackend().actors.createAgentManagementGrant(actorId, ['mcp:install'])
    await manageAgentCapability({
      targetActorId: actorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_MCP,
      action: AgentCapabilityAction.INSTALL_TEAM_ITEM,
      itemId: name,
    })
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  uninstallMcp: async (id) => {
    const item = get().mcp.items.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`mcp server ${id} not found`)
    const actorId = get().subjectActorId
    if (!actorId) throw new Error('请先选择 Agent')
    requireAgentOnline(actorId)
    if (item.kind === 'personal') throw new Error('远程个人 MCP 一期只读')
    const grant = await getBackend().actors.createAgentManagementGrant(actorId, ['mcp:uninstall'])
    await manageAgentCapability({
      targetActorId: actorId,
      managementGrant: grant.grant,
      kind: AgentCapabilityKind.AGENT_MCP,
      action: AgentCapabilityAction.UNINSTALL_TEAM_ITEM,
      itemId: item.name,
    })
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  createMcp: async (input) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    await getBackend().teamMcp.createTeamMcpServer(teamId, input)
    // Deliberately no auto-install: adding to the catalog is not a decision to
    // run the command, not even on the author's own machine.
    await get().loadSection('mcp', { force: true })
  },

  createPersonalMcp: async (input) => {
    const wsPath = workspacePath()
    if (!wsPath) throw new Error('no workspace open')
    const name = (input.name ?? '').trim()
    if (!name) throw new Error('name is required')
    const wid = encodeWorkspaceId(wsPath)
    const current = await getDaemonMcp(wid)
    if (name in current) throw new Error(`mcp server ${name} already exists in this workspace`)
    await putDaemonMcp(wid, { ...current, [name]: writeToDaemonConfig(input) })
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  updateWorkspaceMcp: async (id, patch) => {
    const item = get().mcp.items.find((candidate) => candidate.id === id)
    if (!item || (item.kind !== 'personal' && item.kind !== 'builtin')) {
      throw new Error(`mcp server ${id} is not editable in this workspace`)
    }
    const wsPath = workspacePath()
    if (!wsPath) throw new Error('no workspace open')
    const wid = encodeWorkspaceId(wsPath)
    const current = await getDaemonMcp(wid)
    const prev = current[item.name]
    if (!prev) throw new Error(`mcp server ${item.name} not found in this workspace`)
    await putDaemonMcp(wid, { ...current, [item.name]: writeToDaemonConfig(patch, prev) })
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  toggleMcp: async (id, enabled) => {
    const item = get().mcp.items.find((candidate) => candidate.id === id)
    if (!item || (item.kind !== 'personal' && item.kind !== 'builtin')) {
      throw new Error(`mcp server ${id} has no local toggle`)
    }
    const wsPath = workspacePath()
    if (!wsPath) throw new Error('no workspace open')
    const wid = encodeWorkspaceId(wsPath)
    const current = await getDaemonMcp(wid)
    const prev = current[item.name]
    if (!prev) throw new Error(`mcp server ${item.name} not found in this workspace`)
    await putDaemonMcp(wid, { ...current, [item.name]: { ...prev, enabled } })
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  updateMcp: async (name, patch) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    await getBackend().teamMcp.updateTeamMcpServer(teamId, name, patch)
    await reconcileDaemonTeamCloudConfig()
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  sharePersonalMcp: async (id, input) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const item = get().mcp.items.find((candidate) => candidate.id === id)
    if (!item || item.kind !== 'personal') {
      throw new Error(`mcp server ${id} is not a personal server`)
    }
    const name = item.name
    const body: TeamMcpServerWrite = {
      ...daemonConfigToCatalogWrite(name, item.config),
      description: input?.description ?? null,
    }
    await getBackend().teamMcp.createTeamMcpServer(teamId, body)
    await installDaemonTeamMcp(name)
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  deleteMcp: async (name) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    await getBackend().teamMcp.deleteTeamMcpServer(teamId, name)
    await reconcileDaemonTeamCloudConfig()
    const detail = get().detailTarget
    if (detail?.kind === 'mcp' && detail.name === name) {
      set({ detailTarget: null })
    }
    closeTeamShareTabs((t) => t === encodeTeamShareTarget({ kind: 'mcp', name }))
    await get().loadSection('mcp', { force: true, withTools: true })
  },

  sharePersonalSkill: async (slug, input) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const wsPath = workspacePath()
    const skill = get().skills.items.find((s) => s.slug === slug)
    if (!skill || skill.kind !== 'personal') {
      throw new Error(`${slug} is not a personal skill`)
    }
    if (!skill.dirPath || !skill.filename) {
      throw new Error('personal skill has no directory on disk')
    }
    // skill-loader stores parent dir in dirPath and folder name in filename.
    const sourceDir = `${skill.dirPath}/${skill.filename}`

    // Check the name before anything is uploaded. The server rejects a
    // duplicate slug too, but only after `team_skill_pack_and_upload` has
    // pushed the package — so the user paid for an upload, got a 409, and left
    // an orphaned blob behind, for a condition visible from the list they were
    // looking at. The server check stays as the backstop for a name that
    // appeared since this list was loaded.
    if (get().skills.items.some((s) => s.origin === 'registry' && s.slug === input.slug)) {
      throw new SkillSlugTakenError(input.slug)
    }

    const { getEffectiveServerConfig } = await import('@/lib/server-config')
    const { cloudApiUrl } = await getEffectiveServerConfig()
    if (!cloudApiUrl) throw new Error('Cloud API URL is not configured')
    const accessToken = await getFreshAccessToken()
    if (!accessToken) throw new Error('Not signed in')

    const packed = await invoke<{ contentHash: string; size: number }>('team_skill_pack_and_upload', {
      dirPath: sourceDir,
      slug: input.slug,
      teamId,
      cloudApiUrl,
      accessToken,
    })

    const backend = getBackend()
    const published = await backend.teamSkills.publishTeamSkill(teamId, {
      slug: input.slug,
      summary: input.summary,
      category: input.category,
      whenToUse: input.whenToUse,
      whenNotToUse: input.whenNotToUse,
      changelog: input.changelog,
      contentHash: packed.contentHash,
      size: packed.size,
      requires: input.requires ?? null,
    })

    // Copy-publish: keep the personal dir; materialise the team install under
    // ~/.agents/skills so OpenCode / Claude / Pi all see the same pack.
    //
    // `owner` comes from the row the server just created, not from the personal
    // item — a personal skill has no owner actor, and passing its `null` here
    // stamps the publisher's own copy without the `owner:` field that every
    // other member's copy gets. The pack would then differ from itself
    // depending on who installed it, and the publisher's conflict diff would
    // show a phantom deleted line they never touched.
    await invoke('team_skill_install_from_dir', {
      request: {
        workspacePath: wsPath,
        slug: input.slug,
        teamId,
        sourceDir,
        version: 1,
        owner: published.ownerActorId,
        category: input.category,
        summary: input.summary,
        whenToUse: input.whenToUse,
        whenNotToUse: input.whenNotToUse,
        requires: input.requires ?? null,
        isGlobal: true,
      },
    })
    await ensureAgentsSkillsPaths(wsPath)

    await backend.teamSkills.installTeamSkill(teamId, input.slug, { version: 1 })

    // Retire the original now that the pack exists and the server knows about
    // it. Leaving it produces two files answering to one name, and the pack
    // root ranks below nearly every other skills root — so the copy the author
    // keeps editing is the one that is no longer the team's, while publish and
    // dirty detection read the one they never touch.
    //
    // Only when the names match: a deliberate rename on share means the author
    // wants both. And only after everything above succeeded, so a failed upload
    // never costs them the original.
    let retiredPath: string | null = null
    if (input.slug === skill.filename) {
      retiredPath = await invoke<string>('team_skill_retire_personal', {
        dirPath: sourceDir,
        slug: input.slug,
      }).catch(() => null)
    }

    await get().loadSection('skills', { force: true })
    get().select('skills', input.slug)
    return retiredPath
  },

  publishSkillVersion: async (slug, input) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const wsPath = workspacePath()
    const skill = get().skills.items.find((s) => s.slug === slug)
    if (!skill) throw new Error(`${slug} is not in the registry`)

    const { getEffectiveServerConfig } = await import('@/lib/server-config')
    const { cloudApiUrl } = await getEffectiveServerConfig()
    if (!cloudApiUrl) throw new Error('Cloud API URL is not configured')
    const accessToken = await getFreshAccessToken()
    if (!accessToken) throw new Error('Not signed in')

    // Publish what is on disk right now, including whatever the author edited
    // locally — that content is the whole reason a new version is being cut.
    const sourceDir = await invoke<string>('team_skill_installed_dir', { slug })
    const packed = await invoke<{ contentHash: string; size: number }>('team_skill_pack_and_upload', {
      dirPath: sourceDir,
      slug,
      teamId,
      cloudApiUrl,
      accessToken,
    })

    const backend = getBackend()
    const version = await backend.teamSkills.publishTeamSkillVersion(teamId, slug, {
      contentHash: packed.contentHash,
      size: packed.size,
      changelog: input.changelog,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {}),
      ...(input.whenNotToUse !== undefined ? { whenNotToUse: input.whenNotToUse } : {}),
      ...(input.requires !== undefined ? { requires: input.requires } : {}),
    })

    // Re-baseline against the version just published. Skipping this leaves the
    // author permanently in conflict with their own release, since the disk
    // still differs from the baseline taken at the previous version.
    await invoke('team_skill_install_from_dir', {
      request: {
        workspacePath: wsPath,
        slug,
        teamId,
        sourceDir,
        version: version.version,
        owner: skill.ownerActorId,
        category: input.category ?? skill.category,
        summary: input.summary ?? skill.summary,
        whenToUse: input.whenToUse ?? skill.whenToUse,
        whenNotToUse: input.whenNotToUse ?? skill.whenNotToUse,
        requires: input.requires ?? skill.requires,
        isGlobal: true,
      },
    })
    await backend.teamSkills.installTeamSkill(teamId, slug, { version: version.version })
    await get().reconcileSkills()
    await get().loadSection('skills', { force: true })
  },

  keepArchivedCopy: async (slug, newSlug) => {
    const path = get().skillArchived[slug]
    if (!path) return
    // Restored under a *different* name on purpose. Putting it back where it
    // was would recreate exactly the state auto-follow just resolved — a
    // directory with no team record at the pack's path — so the next tick would
    // archive it again, forever.
    await invoke('team_skill_restore_trashed', { trashedPath: path, slug: newSlug })
    get().dismissArchived(slug)
    await get().loadSection('skills', { force: true })
  },

  dismissArchived: (slug) =>
    set((s) => {
      const next = { ...s.skillArchived }
      delete next[slug]
      return { skillArchived: next }
    }),

  revertSkillVersion: async (slug, version) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    // Rolls forward with the old content rather than moving `latestVersion`
    // back, so auto-follow carries it to everyone the same way the bad version
    // arrived. Without a caller this endpoint was decoration: under auto-follow
    // a broken publish reaches the whole team within one tick, and the author's
    // only other remedy is rebuilding the old bytes by hand.
    await getBackend().teamSkills.revertTeamSkillVersion(teamId, slug, version)
    await get().reconcileSkills()
    await get().loadSection('skills', { force: true })
  },

  reconcileSkills: async () => {
    const teamId = currentTeamId()
    if (!teamId) return
    // Installing onto a team agent is bookkeeping on someone else's machine;
    // reconciling this disk against that actor's set would install their skills
    // here. Auto-follow is always about the signed-in member.
    if (get().subjectActorId) return

    const backend = getBackend()
    let desired
    let listed: OnDiskSkill[]
    try {
      ;[desired, listed] = await Promise.all([
        backend.teamSkills.listTeamSkills(teamId),
        listInstalledPacks(),
      ])
    } catch {
      // Offline, or the registry is unreachable. Leave disk exactly as it is —
      // a failed fetch must never be read as "the team removed everything".
      return
    }

    const states: Record<string, SkillLocalState> = {}
    const errors: Record<string, string> = {}
    const archived: Record<string, string> = { ...get().skillArchived }
    const blocked = new Set<string>()
    const known = new Set<string>([
      ...listed.map((p) => p.slug),
      ...desired.filter((s) => s.installed).map((s) => s.slug),
    ])
    for (const slug of known) {
      const row = desired.find((s) => s.slug === slug)
      const state = await inspectSkill(slug, row?.installedVersion ?? null, teamId).catch(() => null)
      if (!state) continue
      states[slug] = state
      // A local edit needs a decision; another registry's pack is not ours to
      // touch at all. Both mean "auto-follow stops here".
      if (state.state === 'dirty' || state.state === 'foreign') blocked.add(slug)
    }

    // Re-read the disk after inspection rather than reusing the listing above.
    // Inspecting a pack that predates manifests *adopts* it — writes the origin
    // record that makes it visible to `team_skill_list_installed` in the first
    // place — so the pre-inspection listing says "not installed" for exactly
    // the packs most likely to hold a user's untracked edits. Planning from it
    // queues them for a fresh install, and the tick overwrites edits it was
    // never able to see.
    const onDisk = await listInstalledPacks().catch(() => listed)
    const plan = planReconcile(desired, onDisk, blocked, teamId)

    for (const { slug, version } of plan.install) {
      try {
        const { archivedPath } = await materializeSkill(teamId, slug, version, {
          archiveUnmanaged: true,
        })
        if (archivedPath) archived[slug] = archivedPath
        states[slug] = await inspectSkill(slug, version, teamId)
        delete errors[slug]
      } catch (e) {
        // A pack that turned dirty between the inspect and the install; the
        // backstop in the installer caught it.
        if (isDirtyConflict(e)) {
          const state = await inspectSkill(slug, version, teamId).catch(() => null)
          if (state) states[slug] = state
          continue
        }
        // Anything else is a sync that is not going to fix itself by being
        // retried silently forever — a signed URL the storage layer now
        // refuses, a package that 404s. Removing the update button removed the
        // only place these surfaced, so they are recorded and shown in the
        // detail pane instead of leaving the member on a retired version with
        // a permanent "updating…" and no way to know why.
        errors[slug] = e instanceof Error ? e.message : String(e)
      }
    }

    for (const slug of plan.remove) {
      try {
        await invoke('team_skill_uninstall', { workspacePath: workspacePath(), slug, isGlobal: true })
        delete states[slug]
        delete errors[slug]
      } catch {
        // Retried next tick.
      }
    }

    const settled: OnDiskSkill[] = Object.entries(states).map(([slug, s]) => ({
      slug,
      version: s.installedVersion,
      teamId,
    }))
    for (const { slug, version } of planVersionWriteback(desired, settled)) {
      try {
        await backend.teamSkills.installTeamSkill(teamId, slug, { version })
      } catch {
        // The disk is already right; only the record is behind, and the next
        // tick recomputes this from fresh server state and tries again.
      }
    }

    set({ skillSyncErrors: errors, skillArchived: archived })

    set({ skillLocalState: states })
  },

  discardLocalSkill: async (slug) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const skill = get().skills.items.find((s) => s.slug === slug)
    const trashedPath = await invoke<string>('team_skill_discard_local', { slug })
    try {
      await materializeSkill(teamId, slug, skill?.latestVersion ?? 1)
    } catch (e) {
      // Everything up to here already happened: the edits are in the trash and
      // the pack is off the disk. Reporting this as a plain failure would strand
      // the user's work — they get a red toast, no undo, and no idea the bytes
      // still exist. The clean copy comes back on its own next tick; the undo is
      // the part only they can ask for.
      throw new SkillDiscardIncompleteError(trashedPath, e)
    } finally {
      await get().reconcileSkills().catch(() => {})
      await get()
        .loadSection('skills', { force: true })
        .catch(() => {})
    }
    return trashedPath
  },

  restoreDiscardedSkill: async (trashedPath, slug) => {
    await invoke('team_skill_restore_trashed', { trashedPath, slug })
    await get().reconcileSkills()
    await get().loadSection('skills', { force: true })
  },

  forkSkill: async (slug, newSlug) => {
    const path = await invoke<string>('team_skill_fork', { slug, newSlug })
    // The copy is what the user asked for and it is on disk now. Handing the
    // team pack back to auto-follow is cleanup, and cleanup must not be able to
    // fail the whole action: reporting "save failed" after the copy exists sends
    // the user into a retry that can only ever answer "<newSlug> already
    // exists", with no way out but renaming the fork. A discard that did not
    // finish leaves the conflict bar up, which is its own accurate report.
    try {
      await get().discardLocalSkill(slug)
    } catch {
      await get()
        .reconcileSkills()
        .catch(() => {})
    }
    return path
  },

  loadSkillDiff: async (slug) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const local = get().skillLocalState[slug]
    const installedVersion = Number(local?.installedVersion ?? 0)
    if (!installedVersion) return []

    // Rebuild the baseline from the version that is *installed*, and from that
    // version's own metadata snapshot — the current registry row may describe a
    // newer release, and using it would paint the team's changes as the user's.
    const detail = await getBackend().teamSkills.getTeamSkill(teamId, slug)
    const snapshot = detail.versions.find((v) => v.version === installedVersion)
    const { url } = await getBackend().teamSkills.resolveDownload(teamId, slug, installedVersion)
    return invoke<TeamSkillFileDiff[]>('team_skill_diff', {
      request: {
        slug,
        downloadUrl: url,
        accessToken: null,
        version: installedVersion,
        owner: detail.ownerActorId,
        category: detail.category,
        summary: snapshot?.summary ?? detail.summary,
        whenToUse: snapshot?.whenToUse ?? detail.whenToUse,
        whenNotToUse: snapshot?.whenNotToUse ?? detail.whenNotToUse,
        requires: snapshot?.requires ?? detail.requires,
        isGlobal: true,
      },
    })
  },

  loadSection: async (section, opts) => {
    const wsPath = workspacePath()

    if (section === 'env') {
      try {
        await useEnvVarsStore.getState().loadEnvCatalog()
      } catch {
        /* surfaced by env store */
      }
      // The env section manages both scopes now, so the badge counts both.
      const envState = useEnvVarsStore.getState()
      set({ envCount: envState.teamSecrets.length + envState.envVars.length })
      return
    }

    const current = get()[section] as SectionState<unknown>
    if (current.loaded && !opts?.force) {
      if (section === 'mcp' && opts?.withTools) await get().loadMcpTools()
      return
    }

    set(
      (s) =>
        ({ [section]: { ...s[section], loading: true, error: null } }) as Partial<TeamShareBrowserState>,
    )
    try {
      if (section === 'skills') {
        const { items, registryError } = await listTeamSkills(
          wsPath,
          currentTeamId(),
          get().subjectActorId ?? undefined,
        )
        set({ skills: { items, loading: false, loaded: true, error: registryError } })
      } else if (section === 'knowledge') {
        // The tree renders straight off disk now, so this only has to resolve
        // where its root is. The flat listing stays for the nav count.
        //
        // Two things this path has to get right, both of which were wrong:
        //
        // 1. It must be the IN-WORKSPACE path, not `resolveTeamDir`'s answer.
        //    `teamclu-team` is a symlink into ~/.amuxd, and resolveTeamDir
        //    returns the link TARGET — but the workspace file tree is built
        //    from workspace paths, so `findSubtree` looked up an absolute
        //    ~/.amuxd path that is never in the tree and always came back
        //    empty. The column read "No files found" no matter what was on
        //    disk.
        //
        // 2. It must be `knowledge/`, not the team root. File sync carries
        //    that one prefix now, so a file created at the root is silently
        //    never synced, and the team dir's other entries (skills/, .mcp/,
        //    _secrets/, _meta/, _feedback/) are all retired.
        const teamDir = wsPath ? await resolveTeamDir(wsPath) : null
        const root = teamDir && wsPath ? `${wsPath}/${TEAM_REPO_DIR}/knowledge` : null
        if (root) await ensureDir(root)
        const items = wsPath ? await listTeamKnowledge(wsPath) : []
        set({ knowledgeRoot: root, knowledge: { items, loading: false, loaded: true, error: null } })
      } else if (section === 'mcp') {
        const items = wsPath
          ? await listTeamMcp(wsPath, currentTeamId(), get().mcp.items, get().subjectActorId ?? undefined)
          : []
        set({ mcp: { items, loading: false, loaded: true, error: null } })
        if (opts?.withTools) await get().loadMcpTools()
      }
    } catch (e) {
      const msg = section === 'skills' || section === 'mcp'
        ? agentManagementError(e)
        : e instanceof Error ? e.message : String(e)
      set(
        (s) =>
          ({
            [section]: { ...s[section], loading: false, loaded: true, error: msg },
          }) as Partial<TeamShareBrowserState>,
      )
    }
  },

  loadMcpTools: async (opts) => {
    const wsPath = workspacePath()
    if (!wsPath) return
    try {
      const probes = await getDaemonMcpTools(encodeWorkspaceId(wsPath), opts)
      set((s) => ({
        mcp: {
          ...s.mcp,
          items: applyMcpProbes(s.mcp.items, probes),
        },
      }))
    } catch {
      /* leave probeStatus 'unknown' */
    }
  },

  loadCounts: async () => {
    await Promise.allSettled([
      get().loadSection('skills', { force: true }),
      get().loadSection('mcp', { force: true }),
      get().loadSection('env'),
      get().loadSection('knowledge', { force: true }),
    ])
  },
}))

export type { TeamEnvListing }
