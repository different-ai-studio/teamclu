import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Lock, AlertTriangle } from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { KnowledgeAclRule, KnowledgeAclImpact } from '@/lib/backend/cloud-api/knowledge-acl'

interface TeamMember {
  id: string
  displayName: string
}

/**
 * Who may see one knowledge directory.
 *
 * Opened from a folder's context menu, so the directory is already decided —
 * there is nothing to pick, and no path to mistype.
 *
 * ## Permissions only ever narrow going down
 *
 * The server's rule is that a path is denied if ANY prefix covering it lacks a
 * grant for you. A child directory therefore cannot re-open what an ancestor
 * closed: granting Bob here when the parent does not grant him would store a row
 * that changes nothing.
 *
 * So this dialog offers exactly the people the parent already allows. They are
 * listed as the candidates; unchecking one denies them *here and below*. Anyone
 * the parent does not allow is shown greyed out, naming the directory that would
 * have to grant them first — rather than offered as a checkbox that silently
 * does nothing.
 *
 * That constraint is the feature, not a limitation of the UI: "access only gets
 * stricter as you go deeper" is a sentence an administrator can hold in their
 * head, which is the property that matters when someone has to answer "can this
 * person see that file?".
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
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [impact, setImpact] = React.useState<KnowledgeAclImpact | null>(null)
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

  /** Rules on directories strictly above this one. */
  const ancestorRules = React.useMemo(
    () => (rules ?? []).filter((r) => r.pathPrefix !== prefix && prefix.startsWith(r.pathPrefix)),
    [rules, prefix],
  )

  /** A rule on this exact directory, if one has been set. */
  const ownRule = React.useMemo(
    () => (rules ?? []).find((r) => r.pathPrefix === prefix) ?? null,
    [rules, prefix],
  )

  /**
   * Who the parent chain allows here — the intersection of every ancestor rule,
   * or everyone when no ancestor restricts anything.
   */
  const inherited = React.useMemo(() => {
    if (ancestorRules.length === 0) return new Set(members.map((m) => m.id))
    return ancestorRules.reduce<Set<string>>(
      (acc, rule) => new Set(rule.actorIds.filter((id) => acc.has(id))),
      new Set(members.map((m) => m.id)),
    )
  }, [ancestorRules, members])

  // Seed the checkboxes: this directory's own grants where it has a rule,
  // otherwise everything it inherits (so opening and saving changes nothing).
  React.useEffect(() => {
    if (rules === null) return
    const base = ownRule ? ownRule.actorIds.filter((id) => inherited.has(id)) : [...inherited]
    setSelected(new Set(base))
    setImpact(null)
  }, [rules, ownRule, inherited])

  const willRestrict = React.useMemo(
    () => [...inherited].some((id) => !selected.has(id)),
    [inherited, selected],
  )

  const toggle = (actorId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(actorId)) next.delete(actorId)
      else next.add(actorId)
      return next
    })
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

  /** Dry run first — the admin sees the cost before the button that pays it. */
  const checkImpact = () =>
    run(async () => {
      if (!teamId) return
      setImpact(
        await getBackend().knowledgeAcl.previewKnowledgeAcl(teamId, {
          pathPrefix: prefix,
          actorIds: [...selected],
        }),
      )
    })

  const save = () =>
    run(async () => {
      if (!teamId) return
      if (ownRule) {
        const add = [...selected].filter((id) => !ownRule.actorIds.includes(id))
        const remove = ownRule.actorIds.filter((id) => !selected.has(id))
        if (add.length || remove.length) {
          await getBackend().knowledgeAcl.updateKnowledgeAcl(teamId, ownRule.id, {
            addActorIds: add,
            removeActorIds: remove,
          })
        }
      } else {
        await getBackend().knowledgeAcl.createKnowledgeAcl(teamId, {
          pathPrefix: prefix,
          actorIds: [...selected],
          // Only reachable after the impact screen below has been shown.
          confirmRevokeExisting: true,
        })
      }
      onOpenChange(false)
    })

  /** Drop this directory's own rule; it goes back to whatever the parent says. */
  const clearOwnRule = () =>
    run(async () => {
      if (!teamId || !ownRule) return
      await getBackend().knowledgeAcl.deleteKnowledgeAcl(teamId, ownRule.id)
      onOpenChange(false)
    })

  const dirName = prefix.replace(/\/$/, '').split('/').slice(1).join('/') || '/'
  const needsImpactFirst = !ownRule && willRestrict && !impact

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {t('knowledgeAcl.dialogTitle', 'Who can see this folder')}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{dirName}</DialogDescription>
        </DialogHeader>

        {rules === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {ancestorRules.length > 0
                ? t('knowledgeAcl.inheritedFrom', {
                    defaultValue:
                      'Inherited from {{parent}}. You can remove people here, but only someone the parent already allows can be added.',
                    parent: ancestorRules
                      .map((r) => r.pathPrefix)
                      .sort((a, b) => b.length - a.length)[0],
                  })
                : t(
                    'knowledgeAcl.inheritedAll',
                    'No parent folder is restricted, so everyone on the team can see this. Unchecking someone restricts this folder and everything under it.',
                  )}
            </p>

            <ScrollArea className="max-h-64">
              <div className="flex flex-col gap-2 py-1">
                {members.map((m) => {
                  const allowedByParent = inherited.has(m.id)
                  return (
                    <label
                      key={m.id}
                      className={`flex items-center gap-2 text-sm ${allowedByParent ? '' : 'opacity-50'}`}
                    >
                      <Checkbox
                        checked={selected.has(m.id)}
                        disabled={busy || !allowedByParent}
                        onCheckedChange={() => toggle(m.id)}
                      />
                      <span className="truncate">{m.displayName}</span>
                      {!allowedByParent && (
                        <span className="text-xs text-muted-foreground">
                          {t('knowledgeAcl.blockedByParent', 'not allowed by a parent folder')}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            </ScrollArea>

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

            {/*
              Said where the decision is made, not only in settings. Knowledge is
              stored unencrypted server-side; this decides who on the team
              receives a folder, and nothing more.
            */}
            <div className="flex gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                {t(
                  'knowledgeAcl.scopeNoticeShort',
                  'Removing access stops future syncing. It cannot take back copies already on someone’s device.',
                )}
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {ownRule && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clearOwnRule()}>
                {t('knowledgeAcl.clearRule', 'Inherit from parent')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            {needsImpactFirst ? (
              <Button disabled={busy || rules === null} onClick={() => void checkImpact()}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('knowledgeAcl.check', 'Check impact')}
              </Button>
            ) : (
              <Button
                variant={willRestrict ? 'destructive' : 'default'}
                disabled={busy || rules === null}
                onClick={() => void save()}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('common.save', 'Save')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
