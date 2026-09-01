import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Lock, AlertTriangle, X, Plus, Users } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { KnowledgeAclRule, KnowledgeAclImpact } from '@/lib/backend/cloud-api/knowledge-acl'

interface TeamMember {
  id: string
  displayName: string
}

/**
 * Who may see one knowledge directory.
 *
 * Opened from a folder's context menu, so the directory is already decided.
 *
 * ## Why this is an allow-list and not a grid of checkboxes
 *
 * A restriction is stored as an explicit list of actor ids. That has a
 * consequence which decides the whole shape of this dialog: **a rule is a list
 * of people, not a rule about people.** Someone who joins the team next week is
 * not on the list, so they do not get in.
 *
 * That is the right default for a restricted folder, but it makes "everyone
 * except Bob" a trap: expressing it would mean listing the other 299 members,
 * and a month later the list is quietly wrong for everyone hired since. So the
 * dialog never offers that. Restricting a folder means naming who may see it,
 * and the copy says so.
 *
 * It also means the UI must scale to a team far larger than the people on any
 * one list. The team roster is behind a search box; what is rendered is the
 * selection, which is small by construction.
 *
 * ## Permissions only ever narrow going down
 *
 * The server denies a path when ANY prefix covering it lacks a grant, so a child
 * cannot re-open what an ancestor closed. Search results are therefore limited
 * to the people the parent chain already allows — someone else would be a stored
 * grant that changes nothing.
 */
export function KnowledgeAclDialog({
  prefix,
  open,
  onOpenChange,
}: {
  /** Always `knowledge/…/`, with the trailing slash. */
  prefix: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id) ?? null

  const [rules, setRules] = React.useState<KnowledgeAclRule[] | null>(null)
  const [members, setMembers] = React.useState<TeamMember[]>([])
  const [selected, setSelected] = React.useState<string[]>([])
  const [restricting, setRestricting] = React.useState(false)
  const [impact, setImpact] = React.useState<KnowledgeAclImpact | null>(null)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!teamId || !open) return
    setError(null)
    try {
      const [items, memberRows] = await Promise.all([
        getBackend().knowledgeAcl.listKnowledgeAcl(teamId),
        getBackend().actors.listTeamMembersForAccess(teamId),
      ])
      setRules(items)
      setMembers(
        memberRows.map((m: { id: string; displayName: string }) => ({
          id: m.id,
          displayName: m.displayName,
        })),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRules([])
    }
  }, [teamId, open])

  React.useEffect(() => {
    void load()
  }, [load])

  const ancestorRules = React.useMemo(
    () => (rules ?? []).filter((r) => r.pathPrefix !== prefix && prefix.startsWith(r.pathPrefix)),
    [rules, prefix],
  )

  const ownRule = React.useMemo(
    () => (rules ?? []).find((r) => r.pathPrefix === prefix) ?? null,
    [rules, prefix],
  )

  /** Who the parent chain allows here — everyone when no ancestor restricts. */
  const inherited = React.useMemo(() => {
    if (ancestorRules.length === 0) return new Set(members.map((m) => m.id))
    return ancestorRules.reduce<Set<string>>(
      (acc, rule) => new Set(rule.actorIds.filter((id) => acc.has(id))),
      new Set(members.map((m) => m.id)),
    )
  }, [ancestorRules, members])

  React.useEffect(() => {
    if (rules === null) return
    setRestricting(ownRule !== null)
    setSelected(ownRule ? ownRule.actorIds.filter((id) => inherited.has(id)) : [])
    setImpact(null)
  }, [rules, ownRule, inherited])

  const byId = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const selectedMembers = selected.map((id) => byId.get(id)).filter(Boolean) as TeamMember[]

  /** Everyone the parent allows who is not already on the list. */
  const addable = React.useMemo(
    () => members.filter((m) => inherited.has(m.id) && !selected.includes(m.id)),
    [members, inherited, selected],
  )

  const add = (id: string) => {
    setSelected((prev) => [...prev, id])
    setImpact(null)
    setPickerOpen(false)
  }
  const remove = (id: string) => {
    setSelected((prev) => prev.filter((x) => x !== id))
    setImpact(null)
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const checkImpact = () =>
    run(async () => {
      if (!teamId) return
      setImpact(
        await getBackend().knowledgeAcl.previewKnowledgeAcl(teamId, {
          pathPrefix: prefix,
          actorIds: selected,
        }),
      )
    })

  const save = () =>
    run(async () => {
      if (!teamId) return
      if (ownRule) {
        const add = selected.filter((id) => !ownRule.actorIds.includes(id))
        const removed = ownRule.actorIds.filter((id) => !selected.includes(id))
        if (add.length || removed.length) {
          await getBackend().knowledgeAcl.updateKnowledgeAcl(teamId, ownRule.id, {
            addActorIds: add,
            removeActorIds: removed,
          })
        }
      } else {
        await getBackend().knowledgeAcl.createKnowledgeAcl(teamId, {
          pathPrefix: prefix,
          actorIds: selected,
          confirmRevokeExisting: true,
        })
      }
      onOpenChange(false)
    })

  /** Drop this folder's own rule; it goes back to whatever the parent says. */
  const stopRestricting = () =>
    run(async () => {
      if (!teamId || !ownRule) return
      await getBackend().knowledgeAcl.deleteKnowledgeAcl(teamId, ownRule.id)
      onOpenChange(false)
    })

  const dirName = prefix.replace(/\/$/, '').split('/').slice(1).join('/') || '/'
  const parentPrefix = ancestorRules.map((r) => r.pathPrefix).sort((a, b) => b.length - a.length)[0]
  const needsImpactFirst = !ownRule && restricting && !impact

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {t('knowledgeAcl.dialogTitle', 'Who can see this folder')}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{dirName}</DialogDescription>
        </DialogHeader>

        {rules === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : !restricting ? (
          /* Unrestricted: one sentence and one button. Nothing to scroll. */
          <div className="flex flex-col gap-4 py-2">
            <div className="flex items-start gap-3 text-sm">
              <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">
                {parentPrefix
                  ? t('knowledgeAcl.openInherited', {
                      defaultValue:
                        'Everyone {{parent}} allows can see this folder. It has no restriction of its own.',
                      parent: parentPrefix,
                    })
                  : t(
                      'knowledgeAcl.openAll',
                      'Everyone on the team can see this folder, including people who join later.',
                    )}
              </p>
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={() => setRestricting(true)}>
                <Lock className="mr-2 h-3.5 w-3.5" />
                {t('knowledgeAcl.startRestricting', 'Restrict to specific people')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t(
                'knowledgeAcl.allowListNote',
                'Only the people listed here will receive this folder and everything under it. Anyone who joins the team later will not, until you add them.',
              )}
              {parentPrefix
                ? ' ' +
                  t('knowledgeAcl.limitedByParent', {
                    defaultValue: 'You can only add people {{parent}} already allows.',
                    parent: parentPrefix,
                  })
                : ''}
            </p>

            {selectedMembers.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                {t(
                  'knowledgeAcl.noneSelected',
                  'Nobody selected yet — no one but team admins would see this folder.',
                )}
              </p>
            ) : (
              <ScrollArea className="max-h-52 rounded-md border">
                <div className="divide-y">
                  {selectedMembers.map((m) => (
                    <div key={m.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="truncate">{m.displayName}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={t('knowledgeAcl.removePerson', 'Remove')}
                        onClick={() => remove(m.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            {/*
              The roster stays behind a search box. A team can have hundreds of
              members; what gets rendered is the selection, which is small
              because a restricted folder is shared with few people by design.
            */}
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" disabled={busy || addable.length === 0}>
                  <Plus className="mr-2 h-3.5 w-3.5" />
                  {t('knowledgeAcl.addPerson', 'Add person')}
                  <span className="ml-2 text-xs text-muted-foreground">{addable.length}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <Command>
                  <CommandInput
                    placeholder={t('knowledgeAcl.searchPeople', 'Search people…')}
                  />
                  <CommandList>
                    <CommandEmpty>{t('knowledgeAcl.noMatch', 'No match.')}</CommandEmpty>
                    {addable.map((m) => (
                      <CommandItem key={m.id} value={m.displayName} onSelect={() => add(m.id)}>
                        {m.displayName}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {impact && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="text-muted-foreground">
                  {t('knowledgeAcl.impactBody', {
                    defaultValue:
                      '{{members}} member(s) will lose access. {{files}} already-synced file(s) will be removed from their devices on the next sync.',
                    members: impact.affectedMembers,
                    files: impact.affectedFiles,
                  })}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {t(
                    'knowledgeAcl.impactCaveat',
                    'Server content is not deleted, and copies already taken cannot be recalled.',
                  )}
                </p>
              </div>
            )}

            <div className="flex gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                {t(
                  'knowledgeAcl.scopeNoticeShort',
                  'Removing access stops future syncing. It cannot take back copies already on someone’s device.',
                )}
              </p>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {ownRule && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void stopRestricting()}
              >
                {t('knowledgeAcl.clearRule', 'Stop restricting')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            {restricting &&
              (needsImpactFirst ? (
                <Button disabled={busy} onClick={() => void checkImpact()}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('knowledgeAcl.check', 'Check impact')}
                </Button>
              ) : (
                <Button variant="destructive" disabled={busy} onClick={() => void save()}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('common.save', 'Save')}
                </Button>
              ))}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
