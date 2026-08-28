import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Command as CommandIcon, Zap, Loader2, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
// Commands come solely from the frontend skill/role scan.
export type Command = {
  name: string;
  description?: string;
  template?: string;
  source?: string;
  _type?: 'role' | 'skill' | 'command';
}
import { SKILLS_CHANGED_EVENT } from '@/hooks/useAppInit'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'
import { shouldReloadPickerFromDaemonRefresh } from '@/components/chat/command-popover-skills-refresh'
import { useWorkspaceStore } from '@/stores/workspace'
import { attachmentsForSession, useRuntimeStateStore } from '@/stores/runtime-state-store'
import { isTauri } from '@/lib/utils'
import { encodeWorkspaceId, getDaemonPermissions } from '@/lib/daemon-local-client'
import { resolveSkillPermission, type SkillPermissionMap } from '@/lib/teamclu-config'
import { loadAllRoles, loadRolesSkillsWorkspaceState } from '@/lib/roles/loader'

interface CommandPopoverProps {
  activeSessionId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSelect: (command: Command) => void
}

interface SkillEntry {
  name: string
  invocationName: string
  description: string
  path: string
  permissionKey: string
}

interface RoleEntry {
  name: string
  slug: string
  description: string
}

function isSkillEntry(item: CommandOrSkill): item is SkillEntry {
  return 'invocationName' in item
}

function isRoleEntry(item: PickerItem): item is RoleEntry {
  return 'slug' in item
}

// Unified type for display in the list
type CommandOrSkill = Command | SkillEntry
type PickerItem = Command | SkillEntry | RoleEntry

function looksLikeSkillInvocationName(name: string): boolean {
  return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(name)
}

function summarizeRuntimeStates(
  runtimeStates: Record<string, { info?: { availableCommands?: Array<{ name: string; description?: string; inputHint?: string }> } }>,
) {
  return Object.fromEntries(
    Object.entries(runtimeStates).map(([runtimeId, state]) => [
      runtimeId,
      {
        commandCount: state.info?.availableCommands?.length ?? 0,
        commandNames: state.info?.availableCommands?.map((command) => command.name) ?? [],
      },
    ]),
  )
}

function dedupeSkillEntries(skills: SkillEntry[]): SkillEntry[] {
  const seen = new Map<string, SkillEntry>()
  for (const skill of skills) {
    const key = skill.invocationName || skill.name
    if (!seen.has(key)) {
      seen.set(key, skill)
    }
  }
  return Array.from(seen.values())
}

async function scanAvailableSkills(workspacePath: string): Promise<SkillEntry[]> {
  const state = await loadRolesSkillsWorkspaceState(workspacePath)
  return state.skills
    .map((skill) => ({
      name: skill.name,
      invocationName: skill.invocationName ?? skill.filename,
      description: skill.description?.trim() || '',
      path: skill.filename,
      permissionKey: skill.invocationName ?? skill.filename,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function loadSkillPermissionsForSession(
  workspacePath: string,
): Promise<SkillPermissionMap> {
  if (isTauri()) {
    try {
      const perms = await getDaemonPermissions(encodeWorkspaceId(workspacePath))
      if (perms) {
        return perms
      }
    } catch (error) {
      console.warn('[CommandPopover] daemon permissions unavailable, using empty allow map:', error)
    }
  }
  return {}
}

async function scanAvailableRoles(workspacePath: string): Promise<RoleEntry[]> {
  const roles = await loadAllRoles(workspacePath)
  return roles
    .map((role) => ({
      name: role.name,
      slug: role.slug,
      description: role.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function loadSessionRuntimeCommands(
  activeSessionId: string | null,
  runtimeStates: Record<string, { info?: { availableCommands?: Array<{ name: string; description?: string; inputHint?: string }> } }>,
): Promise<Command[]> {
  if (!activeSessionId) {
    console.info('[CommandPopover] skip runtime command load: no active session')
    return []
  }

  // The retain files the session's attachment under its session id and carries
  // the backend's model list + slash commands with it, so there is no runtime
  // table left to query.
  // Walk the attachments directly. Going through a row list and then a keyed
  // lookup would have to reconstruct the store's (actor, session) key, which is
  // exactly the kind of id round-trip this migration removes.
  const attachments = attachmentsForSession(
    activeSessionId,
    useRuntimeStateStore.getState().byRuntimeId,
  )

  console.info('[CommandPopover] session attachments loaded', {
    activeSessionId,
    attachmentCount: attachments.length,
    runtimeStateSummary: summarizeRuntimeStates(runtimeStates),
  })

  const deduped = new Map<string, Command>()
  for (const attachment of attachments) {
    const commands = attachment.info?.availableCommands ?? []
    console.info('[CommandPopover] commands for attachment', {
      activeSessionId,
      daemonActorId: attachment.daemonActorId,
      commandCount: commands.length,
      commandNames: commands.map((command) => command.name),
    })
    for (const command of commands) {
      if (!command?.name || deduped.has(command.name)) continue
      deduped.set(command.name, {
        name: command.name,
        description: command.description || undefined,
        template: command.inputHint?.trim() ? `${command.name} ${command.inputHint.trim()}` : command.name,
        source: 'command',
      })
    }
  }

  const loadedCommands = Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name))
  console.info('[CommandPopover] daemon command load result', {
    activeSessionId,
    commandCount: loadedCommands.length,
    commandNames: loadedCommands.map((command) => command.name),
  })
  return loadedCommands
}

// Filter items by search query
function filterItems<T extends { name: string; description?: string }>(
  items: T[], 
  query: string, 
  limit: number = 15
): T[] {
  if (!query) return items.slice(0, limit)
  
  const lowerQuery = query.toLowerCase()
  return items
    .filter(item => {
      const lowerName = item.name.toLowerCase()
      const lowerDesc = item.description?.toLowerCase() || ''
      return lowerName.includes(lowerQuery) || lowerDesc.includes(lowerQuery)
    })
    .slice(0, limit)
}

export function CommandPopover({
  activeSessionId,
  open,
  onOpenChange,
  searchQuery,
  onSelect,
}: CommandPopoverProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const [commands, setCommands] = React.useState<Command[]>([])
  const [roles, setRoles] = React.useState<RoleEntry[]>([])
  const [skills, setSkills] = React.useState<CommandOrSkill[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const [skillsRevision, setSkillsRevision] = React.useState(0)
  const runtimeRefresh = useWorkspaceRuntimeRefreshStore((s) => s.refresh)
  const lastDaemonSkillsRefreshAt = React.useRef<string | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const bump = () => setSkillsRevision((value) => value + 1)
    window.addEventListener(SKILLS_CHANGED_EVENT, bump)
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, bump)
  }, [])

  React.useEffect(() => {
    const decision = shouldReloadPickerFromDaemonRefresh(
      runtimeRefresh,
      lastDaemonSkillsRefreshAt.current,
    )
    if (!decision.reload) return
    lastDaemonSkillsRefreshAt.current = decision.nextHandledAt
    setSkillsRevision((value) => value + 1)
  }, [runtimeRefresh?.last_detected_at, runtimeRefresh?.change_kinds])
  
  // Load commands and skills when popover opens
  React.useEffect(() => {
    if (open) {
      setIsLoading(true)
      console.info('[CommandPopover] open: loading picker items', {
        activeSessionId,
        workspacePath,
        isTauri: isTauri(),
        searchQuery,
        runtimeStateIds: Object.keys(runtimeStates),
        runtimeStateSummary: summarizeRuntimeStates(runtimeStates),
      })
      
      const commandsPromise = loadSessionRuntimeCommands(activeSessionId, runtimeStates)
      
      // Load skills from .claude/skills/ (only on Tauri)
      const skillsPromise = (isTauri() && workspacePath)
        ? scanAvailableSkills(workspacePath).catch(error => {
            console.error('[CommandPopover] Failed to scan skills:', error)
            return []
          })
        : Promise.resolve([])

      const rolesPromise = (isTauri() && workspacePath)
        ? scanAvailableRoles(workspacePath).catch(error => {
            console.error('[CommandPopover] Failed to scan roles:', error)
            return []
          })
        : Promise.resolve([])

      const permissionsPromise = workspacePath
        ? loadSkillPermissionsForSession(workspacePath).catch(error => {
            console.error('[CommandPopover] Failed to load skill permissions:', error)
            return {}
          })
        : Promise.resolve({})
      
      Promise.all([commandsPromise, skillsPromise, rolesPromise, permissionsPromise])
        .then(([cmds, skls, loadedRoles, permissions]) => {
          console.info('[CommandPopover] picker sources loaded', {
            activeSessionId,
            daemonCommandCount: cmds.length,
            daemonCommandNames: cmds.map((command) => command.name),
            localSkillCount: skls.length,
            localSkillInvocations: skls.map((skill) => skill.invocationName),
            roleCount: loadedRoles.length,
            permissionKeyCount: Object.keys(permissions).length,
          })
          const deniedSkillNames = new Set(
            skls
              .filter((skill) => resolveSkillPermission(skill.permissionKey, permissions).permission === 'deny')
              .map((skill) => skill.name)
          )

          const allowedFrontendSkills = skls.filter(
            (skill) => resolveSkillPermission(skill.permissionKey, permissions).permission !== 'deny'
          )

          const skillByInvocation = new Map(
            allowedFrontendSkills.map((skill) => [skill.invocationName, skill]),
          )
          const skillByFilename = new Map(
            allowedFrontendSkills.map((skill) => [skill.path, skill]),
          )

          const runtimeSkills: SkillEntry[] = []
          const runtimeCommands: Command[] = []
          const runtimeSkillKeys = new Set<string>()

          for (const cmd of cmds) {
            const matchedSkill = skillByInvocation.get(cmd.name) ?? skillByFilename.get(cmd.name)
            if (matchedSkill) {
              if (deniedSkillNames.has(matchedSkill.name)) continue
              const dedupeKey = matchedSkill.invocationName || matchedSkill.name
              if (runtimeSkillKeys.has(dedupeKey)) continue
              runtimeSkillKeys.add(dedupeKey)
              console.info('[CommandPopover] classified daemon command as known skill', {
                commandName: cmd.name,
                skillName: matchedSkill.name,
                invocationName: matchedSkill.invocationName,
              })
              runtimeSkills.push(matchedSkill)
            } else if (looksLikeSkillInvocationName(cmd.name)) {
              const daemonSkill: SkillEntry = {
                name: cmd.name,
                invocationName: cmd.name,
                description: cmd.description ?? '',
                path: '',
                permissionKey: cmd.name,
              }
              if (resolveSkillPermission(daemonSkill.permissionKey, permissions).permission === 'deny') continue
              console.info('[CommandPopover] classified daemon command as namespaced skill', {
                commandName: cmd.name,
              })
              runtimeSkills.push(daemonSkill)
            } else {
              console.info('[CommandPopover] classified daemon command as command', {
                commandName: cmd.name,
              })
              runtimeCommands.push(cmd)
            }
          }
          
          // Merge frontend-scanned skills with runtime-advertised skills.
          const skillInvocationSet = new Set(runtimeSkills.map((skill) => skill.invocationName))
          const uniqueFrontendSkills = allowedFrontendSkills.filter(
            (skill) => !skillInvocationSet.has(skill.invocationName),
          )
          
          setCommands(runtimeCommands)
          setRoles(loadedRoles)
          setSkills(dedupeSkillEntries([...runtimeSkills, ...uniqueFrontendSkills]))
          console.info('[CommandPopover] picker state set', {
            activeSessionId,
            runtimeSkillCount: runtimeSkills.length,
            runtimeSkillNames: runtimeSkills.map((skill) => skill.invocationName),
            localOnlySkillCount: uniqueFrontendSkills.length,
            commandCount: runtimeCommands.length,
            commandNames: runtimeCommands.map((command) => command.name),
            roleCount: loadedRoles.length,
          })
          setIsLoading(false)
        })
    } else {
      setRoles([])
      setSkills([])
      setCommands([])
    }
  }, [activeSessionId, open, runtimeStates, workspacePath, skillsRevision])
  
  React.useEffect(() => {
    if (!open) {
      setHighlightedIndex(0)
    }
  }, [open])
  
  // Filter commands and skills based on search query
  const filteredRoles = React.useMemo(() => {
    return filterItems(roles, searchQuery, 20)
  }, [roles, searchQuery])

  const filteredSkills = React.useMemo(() => {
    return filterItems(skills, searchQuery, 20)
  }, [skills, searchQuery])
  
  const filteredCommands = React.useMemo(() => {
    return filterItems(commands, searchQuery, 20)
  }, [commands, searchQuery])
  
  // Combine all items for keyboard navigation, with type metadata
  const allItems = React.useMemo(() => {
    const rolesWithType = filteredRoles.map(r => ({ ...r, _itemType: 'role' as const }))
    const skillsWithType = filteredSkills.map(s => ({ ...s, _itemType: 'skill' as const }))
    const commandsWithType = filteredCommands.map(c => ({ ...c, _itemType: 'command' as const }))
    return [...rolesWithType, ...skillsWithType, ...commandsWithType]
  }, [filteredRoles, filteredSkills, filteredCommands])
  
  React.useEffect(() => {
    setHighlightedIndex(0)
  }, [allItems])
  
  const handleSelect = React.useCallback((item: PickerItem & { _itemType: 'role' | 'skill' | 'command' }) => {
    console.log('[CommandPopover] 🎯 handleSelect called, item:', item.name, 'type:', item._itemType);
    onSelect({
      name:
        item._itemType === 'skill' && isSkillEntry(item)
          ? item.invocationName
          : item._itemType === 'role' && isRoleEntry(item)
            ? item.slug
            : item.name,
      description: item.description,
      _type: item._itemType,
    } as Command)
    console.log('[CommandPopover] ✅ onSelect called, closing popover');
    onOpenChange(false)
  }, [onSelect, onOpenChange])
  
  // Scroll highlighted item into view
  React.useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`)
    item?.scrollIntoView({ block: "nearest" })
  }, [highlightedIndex])
  
  // Keyboard navigation
  React.useEffect(() => {
    if (!open || allItems.length === 0) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => (i + 1) % allItems.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => (i - 1 + allItems.length) % allItems.length)
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) return
        e.preventDefault()
        e.stopPropagation()
        const item = allItems[highlightedIndex]
        if (item) handleSelect(item)
      }
    }

    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open, allItems, highlightedIndex, handleSelect])
  
  if (!open) return null
  
  const totalCount = filteredRoles.length + filteredSkills.length + filteredCommands.length
  const highlightedItem = allItems[highlightedIndex]
  let currentIndex = 0
  
  return (
    <div className="absolute bottom-full left-0 mb-2 rounded-lg border bg-popover shadow-lg z-50 animate-in fade-in slide-in-from-bottom-2 duration-200 flex">
      {/* Left: List */}
      <div className="w-64 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 text-[10px] text-muted-foreground border-b bg-muted/30">
          <span className="font-medium">
            {t('chat.commandPopover.prompt', 'Select role, skill, or command')}
          </span>
          {searchQuery && (
            <span className="text-[9px] text-primary font-mono">
              {searchQuery}
            </span>
          )}
          {!searchQuery && totalCount > 0 && (
            <span className="text-[9px]">
              {t('chat.commandPopover.itemCount', { count: totalCount })}
            </span>
          )}
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1 flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading...')}
          </div>
        ) : totalCount === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {searchQuery
              ? t('chat.commandPopover.noMatch', { query: searchQuery })
              : t('chat.commandPopover.empty', 'No skills or commands found')}
          </div>
        ) : (
          <>
            {filteredRoles.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  {t('chat.commandPopover.roles', { count: filteredRoles.length })}
                </div>
                {filteredRoles.map((role) => {
                  const index = currentIndex++
                  return (
                    <div
                      key={`role-${role.slug}`}
                      data-index={index}
                      onClick={() => handleSelect(allItems[index])}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                        index === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      )}
                    >
                      <UserRound className="h-4 w-4 text-sky-600 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">
                          {role.name}
                        </div>
                        {role.slug !== role.name && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {role.slug}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {filteredSkills.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  {t('chat.commandPopover.skills', { count: filteredSkills.length })}
                </div>
                {filteredSkills.map((skill) => {
                  const index = currentIndex++
                  return (
                    <div
                      key={`skill-${skill.name}`}
                      data-index={index}
                      onClick={() => handleSelect(allItems[index])}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                        index === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      )}
                    >
                      <Zap className="h-4 w-4 text-yellow-500 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">
                          {skill.name}
                        </div>
                        {isSkillEntry(skill) && skill.invocationName !== skill.name && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {skill.invocationName}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
            
            {filteredCommands.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  {t('chat.commandPopover.commands', { count: filteredCommands.length })}
                </div>
                {filteredCommands.map((cmd) => {
                  const index = currentIndex++
                  return (
                    <div
                      key={`cmd-${cmd.name}`}
                      data-index={index}
                      onClick={() => handleSelect(allItems[index])}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                        index === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      )}
                    >
                      <CommandIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="text-xs font-medium truncate">
                        /{cmd.name}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}
        </div>

        {/* Hint bar */}
        <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground/60 border-t">
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↑↓</kbd> {t('chat.commandPopover.navigate', 'navigate')}</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">{t('chat.commandPopover.enterOrTab', '↵/Tab')}</kbd> {t('chat.commandPopover.select', 'select')}</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">Esc</kbd> {t('chat.commandPopover.close', 'close')}</span>
        </div>
      </div>

      {/* Right: Description panel */}
      {highlightedItem && highlightedItem.description && (
        <div className="w-80 border-l bg-muted/20 flex flex-col">
          <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground border-b bg-muted/30">
            {t('chat.commandPopover.description', 'Description')}
          </div>
          <div className="p-3 text-[10px] text-muted-foreground leading-relaxed overflow-y-auto flex-1 max-h-80">
            {highlightedItem.description}
          </div>
        </div>
      )}
    </div>
  )
}
