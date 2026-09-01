import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Plus, Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { useTeamPermissions } from '@/lib/team-permissions'
import { useCurrentTeamStore } from '@/stores/current-team'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingCard, SectionHeader } from './shared'
import type {
  KnowledgeAclRule,
  KnowledgeAclImpact,
} from '@/lib/backend/cloud-api/knowledge-acl'

/**
 * Knowledge access — per-directory permissions for the team vault.
 *
 * Design: docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * Owner/admin only; the API refuses everyone else, and this page just declines
 * to render for them.
 *
 * Two things about this screen are load-bearing rather than cosmetic:
 *
 *   1. **The confirmation step.** Restricting a directory that already holds
 *      files takes them off every unlisted member's device. The impact numbers
 *      come from a server-side dry run, and the API refuses the write without
 *      `confirmRevokeExisting`, so the admin cannot get here by accident.
 *   2. **The wording.** We say access "stops syncing", never "is revoked" or
 *      "is recalled". Content already copied to someone's disk cannot be taken
 *      back, and a permissions screen that implies otherwise is how people end
 *      up putting genuinely sensitive material somewhere it does not belong.
 */
export function KnowledgeAclSection() {
  const { t } = useTranslation()
  // `canManageTeam` is the repo's existing owner-or-admin gate (env vars,
  // shared-secret deletion). The API enforces the same thing server-side; this
  // only decides whether to render the page.
  const { canManageTeam: canManage } = useTeamPermissions()

  const [rules, setRules] = React.useState<KnowledgeAclRule[] | null>(null)
  const [members, setMembers] = React.useState<{ id: string; displayName: string }[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  // Draft for a new rule.
  const [draftPrefix, setDraftPrefix] = React.useState('')
  const [draftActorIds, setDraftActorIds] = React.useState<string[]>([])
  const [impact, setImpact] = React.useState<KnowledgeAclImpact | null>(null)

  const teamId = useCurrentTeamStore((s) => s.team?.id) ?? null

  const load = React.useCallback(async () => {
    if (!teamId || !canManage) return
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
  }, [teamId, canManage])

  React.useEffect(() => {
    void load()
  }, [load])

  const resetDraft = () => {
    setDraftPrefix('')
    setDraftActorIds([])
    setImpact(null)
  }

  /** Normalise what the admin typed into the shape the API requires. */
  const normalisedPrefix = React.useMemo(() => {
    const raw = draftPrefix.trim().replace(/^\/+/, '')
    if (!raw) return ''
    const withScope = raw.startsWith('knowledge/') ? raw : `knowledge/${raw}`
    return withScope.endsWith('/') ? withScope : `${withScope}/`
  }, [draftPrefix])

  /**
   * Ask the server what this would cost before offering the button that does it.
   * Never writes — `preview` exists precisely so the number can be shown first.
   */
  const checkImpact = async () => {
    if (!teamId || !normalisedPrefix) return
    setBusy(true)
    setError(null)
    try {
      setImpact(
        await getBackend().knowledgeAcl.previewKnowledgeAcl(teamId, {
          pathPrefix: normalisedPrefix,
          actorIds: draftActorIds,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!teamId || !normalisedPrefix) return
    setBusy(true)
    setError(null)
    try {
      await getBackend().knowledgeAcl.createKnowledgeAcl(teamId, {
        pathPrefix: normalisedPrefix,
        actorIds: draftActorIds,
        // Only ever true once the admin has seen the numbers above.
        confirmRevokeExisting: true,
      })
      resetDraft()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleGrant = async (rule: KnowledgeAclRule, actorId: string) => {
    if (!teamId) return
    const granted = rule.actorIds.includes(actorId)
    setBusy(true)
    setError(null)
    try {
      await getBackend().knowledgeAcl.updateKnowledgeAcl(teamId, rule.id,
        granted ? { removeActorIds: [actorId] } : { addActorIds: [actorId] },
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (rule: KnowledgeAclRule) => {
    if (!teamId) return
    setBusy(true)
    setError(null)
    try {
      await getBackend().knowledgeAcl.deleteKnowledgeAcl(teamId, rule.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!canManage) {
    return (
      <div className="mx-auto w-full max-w-[960px] p-6">
        <SectionHeader
          icon={Lock}
          title={t('settings.knowledgeAcl.title', 'Knowledge Access')}
          description={t(
            'settings.knowledgeAcl.ownerOnly',
            'Only the team owner or an admin can manage knowledge directory access.',
          )}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4 p-6">
      <SectionHeader
        icon={Lock}
        title={t('settings.knowledgeAcl.title', 'Knowledge Access')}
        description={t(
          'settings.knowledgeAcl.description',
          'Restrict a knowledge directory to specific members. Anyone not listed stops receiving it.',
        )}
      />

      {/*
        Said once, plainly, on the page where someone decides to trust this.
        Knowledge is stored unencrypted server-side; this controls who inside the
        team receives it, and nothing more.
      */}
      <SettingCard>
        <div className="flex gap-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {t(
              'settings.knowledgeAcl.scopeNotice',
              'This controls who on your team receives a directory. Knowledge is stored unencrypted on the server, so it is not hidden from whoever operates it. Removing access stops future syncing — it cannot take back copies already on someone’s device.',
            )}
          </p>
        </div>
      </SettingCard>

      {error && (
        <SettingCard>
          <p className="text-sm text-destructive">{error}</p>
        </SettingCard>
      )}

      {/* ── Existing rules ─────────────────────────────────────────────── */}
      {rules === null ? (
        <SettingCard>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        </SettingCard>
      ) : rules.length === 0 ? (
        <SettingCard>
          <p className="text-sm text-muted-foreground">
            {t(
              'settings.knowledgeAcl.empty',
              'No restricted directories. Every member receives the whole knowledge vault.',
            )}
          </p>
        </SettingCard>
      ) : (
        rules.map((rule) => (
          <SettingCard key={rule.id}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-mono text-sm">{rule.pathPrefix}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('settings.knowledgeAcl.grantedCount', {
                    defaultValue: '{{count}} member(s) have access',
                    count: rule.actorIds.length,
                  })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void remove(rule)}
                aria-label={t('settings.knowledgeAcl.removeRule', 'Remove restriction')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              {members.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={rule.actorIds.includes(m.id)}
                    disabled={busy}
                    onCheckedChange={() => void toggleGrant(rule, m.id)}
                  />
                  <span className="truncate">{m.displayName}</span>
                </label>
              ))}
            </div>
          </SettingCard>
        ))
      )}

      {/* ── New rule ───────────────────────────────────────────────────── */}
      <SettingCard>
        <p className="mb-3 text-sm font-medium">
          {t('settings.knowledgeAcl.addTitle', 'Restrict a directory')}
        </p>
        <Input
          value={draftPrefix}
          placeholder="knowledge/hr/"
          disabled={busy}
          onChange={(e) => {
            setDraftPrefix(e.target.value)
            // Any edit invalidates the numbers below — never let a confirm
            // button carry an impact figure computed for a different directory.
            setImpact(null)
          }}
        />
        {normalisedPrefix && normalisedPrefix !== draftPrefix.trim() && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">{normalisedPrefix}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-3">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draftActorIds.includes(m.id)}
                disabled={busy}
                onCheckedChange={() => {
                  setDraftActorIds((prev) =>
                    prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                  )
                  setImpact(null)
                }}
              />
              <span className="truncate">{m.displayName}</span>
            </label>
          ))}
        </div>

        {/*
          The confirmation screen. The admin sees what this costs before the
          button that does it appears — which is the whole reason `preview` is a
          separate endpoint.
        */}
        {impact && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium">
              {t('settings.knowledgeAcl.impactTitle', {
                defaultValue: 'This will restrict {{prefix}}.',
                prefix: impact.pathPrefix,
              })}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t('settings.knowledgeAcl.impactBody', {
                defaultValue:
                  '{{members}} member(s) will lose access. {{files}} already-synced file(s) will be removed from their devices on the next sync.',
                members: impact.affectedMembers,
                files: impact.affectedFiles,
              })}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t(
                'settings.knowledgeAcl.impactCaveat',
                'Server content is not deleted, and copies already taken cannot be recalled.',
              )}
            </p>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {!impact ? (
            <Button disabled={busy || !normalisedPrefix} onClick={() => void checkImpact()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.knowledgeAcl.check', 'Check impact')}
            </Button>
          ) : (
            <>
              <Button variant="destructive" disabled={busy} onClick={() => void create()}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Plus className="mr-2 h-4 w-4" />
                {t('settings.knowledgeAcl.confirm', 'Restrict directory')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={resetDraft}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </>
          )}
        </div>
      </SettingCard>
    </div>
  )
}
