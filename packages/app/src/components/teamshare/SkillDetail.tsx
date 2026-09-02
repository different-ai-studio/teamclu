import * as React from 'react'
import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Save, Loader2, Download, Share2, Trash2, Archive, AlertTriangle, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { encodeWorkspaceId, putDaemonSkill } from '@/lib/daemon-local-client'
import { useTeamShareBrowserStore, isSkillDirtyConflict, SkillDiscardIncompleteError, SkillSlugTakenError, SkillPublishedRefreshError, SkillMutationRefreshError, SkillRuntimeRefreshError, StaleTeamSkillPublishError, StaleDirtySkillPublishError, type TeamSkillFileDiff, type DraftRecoveryRecord } from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getBackend } from '@/lib/backend/provider'
import { type TeamSkillCategory, type TeamSkillVersion } from '@/lib/backend/cloud-api/team-skills'
import { useIsDark } from './use-is-dark'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useEffectiveWorkspacePath } from '@/lib/effective-workspace'
import { toastSkillMutationRefreshFailed } from './skillMutationRefreshToast'
import { ConflictBar } from './skill-detail/ConflictBar'
import { DiffSheet } from './skill-detail/DiffSheet'
import { ForkSheet } from './skill-detail/ForkSheet'
import { MetaRow } from './skill-detail/MetaRow'
import { PublishVersionSheet } from './skill-detail/PublishVersionSheet'
import { ShareSheet } from './skill-detail/ShareSheet'
import { UsageBoundary } from './skill-detail/UsageBoundary'
import { VersionHistory } from './skill-detail/VersionHistory'

type SkillConfirmAction = 'delete' | 'uninstall'

const CodeEditor = lazy(() => import('@/components/editors/CodeEditor'))

export function SkillDetail({ slug }: { slug: string }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const workspacePath = useEffectiveWorkspacePath()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  // By id, not slug: a personal skill colliding with a registry name carries
  // `personal:<slug>`, and matching on slug would resolve both rows to the
  // registry one.
  const item = useTeamShareBrowserStore(
    (s) => s.skills.items.find((x) => x.id === slug) ?? s.skills.items.find((x) => x.slug === slug),
  )
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const installSkill = useTeamShareBrowserStore((s) => s.installSkill)
  const uninstallSkill = useTeamShareBrowserStore((s) => s.uninstallSkill)
  const deletePersonalSkill = useTeamShareBrowserStore((s) => s.deletePersonalSkill)
  const retrySkillsRuntimeRefresh = useTeamShareBrowserStore((s) => s.retrySkillsRuntimeRefresh)
  const publishSkillVersion = useTeamShareBrowserStore((s) => s.publishSkillVersion)
  const discardLocalSkill = useTeamShareBrowserStore((s) => s.discardLocalSkill)
  const restoreDiscardedSkill = useTeamShareBrowserStore((s) => s.restoreDiscardedSkill)
  const sharePersonalSkill = useTeamShareBrowserStore((s) => s.sharePersonalSkill)
  const allSkills = useTeamShareBrowserStore((s) => s.skills.items)
  const forkSkill = useTeamShareBrowserStore((s) => s.forkSkill)
  const loadSkillDiff = useTeamShareBrowserStore((s) => s.loadSkillDiff)
  const loadSkillTeamUpdatesDiff = useTeamShareBrowserStore((s) => s.loadSkillTeamUpdatesDiff)
  const loadSkillDraftMetadata = useTeamShareBrowserStore((s) => s.loadSkillDraftMetadata)
  const listDraftRecoveries = useTeamShareBrowserStore((s) => s.listDraftRecoveries)
  const draftRecoveryRevision = useTeamShareBrowserStore((s) => s.draftRecoveryRevision)
  const rebaseSkillOnLatest = useTeamShareBrowserStore((s) => s.rebaseSkillOnLatest)
  const localState = useTeamShareBrowserStore((s) => s.skillLocalState[slug])
  // Derived, not selected: a selector returning a fresh Set re-renders on every
  // store change, since the reference is new each time it runs.
  const registrySlugs = React.useMemo(
    () => new Set(allSkills.filter((x) => x.origin === 'registry').map((x) => x.slug)),
    [allSkills],
  )
  const syncError = useTeamShareBrowserStore((s) => s.skillSyncErrors[slug])
  const archivedPath = useTeamShareBrowserStore((s) => s.skillArchived[slug])
  // Optional-chained for the same reason as TeamSkillAutoFollow: partial store
  // doubles in tests never set this field.
  const retired = useTeamShareBrowserStore((s) => s.skillRetired?.[item?.slug ?? slug])
  const dismissRetired = useTeamShareBrowserStore((s) => s.dismissRetired)
  const keepArchivedCopy = useTeamShareBrowserStore((s) => s.keepArchivedCopy)
  const dismissArchived = useTeamShareBrowserStore((s) => s.dismissArchived)
  const reconcileSkills = useTeamShareBrowserStore((s) => s.reconcileSkills)
  const revertSkillVersion = useTeamShareBrowserStore((s) => s.revertSkillVersion)
  const select = useTeamShareBrowserStore((s) => s.select)
  const openDetail = useTeamShareBrowserStore((s) => s.openDetail)
  const detachMarketplaceSkill = useTeamShareBrowserStore((s) => s.detachMarketplaceSkill)
  const subjectActorId = useTeamShareBrowserStore((s) => s.subjectActorId)
  useActorPresenceStore((s) =>
    subjectActorId ? s.byActorId[subjectActorId]?.online : undefined,
  )
  const agentOffline = subjectActorId
    ? resolveAgentDevicePresenceSync(subjectActorId) === 'offline'
    : true

  const [content, setContent] = React.useState(item?.content ?? '')
  const [saving, setSaving] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [publishOpen, setPublishOpen] = React.useState(false)
  const [forkOpen, setForkOpen] = React.useState(false)
  const [diffOpen, setDiffOpen] = React.useState(false)
  const [diffs, setDiffs] = React.useState<TeamSkillFileDiff[] | null>(null)
  const [teamDiffs, setTeamDiffs] = React.useState<TeamSkillFileDiff[] | null>(null)
  const [diffTab, setDiffTab] = React.useState<'local' | 'team'>('local')
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [teamDiffLoading, setTeamDiffLoading] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<SkillConfirmAction | null>(null)
  const [versions, setVersions] = React.useState<TeamSkillVersion[]>([])
  const [versionsLoading, setVersionsLoading] = React.useState(false)
  const [recoveries, setRecoveries] = React.useState<DraftRecoveryRecord[]>([])
  const [ownerLabel, setOwnerLabel] = React.useState<string | null>(null)
  const baseline = item?.content ?? ''

  React.useEffect(() => {
    setContent(item?.content ?? '')
  }, [slug, item?.content])

  React.useEffect(() => {
    if (!item || !teamId) {
      setRecoveries([])
      return
    }
    let cancelled = false
    void listDraftRecoveries(item.slug).then((rows) => {
      if (!cancelled) setRecoveries(rows)
    })
    return () => {
      cancelled = true
    }
  }, [item?.slug, teamId, listDraftRecoveries, draftRecoveryRevision])

  React.useEffect(() => {
    if (!item || item.origin !== 'registry' || !teamId) {
      setVersions([])
      setOwnerLabel(null)
      return
    }
    let cancelled = false
    setVersionsLoading(true)
    void (async () => {
      try {
        const detail = await getBackend().teamSkills.getTeamSkill(teamId, item.slug)
        if (cancelled) return
        setVersions(detail.versions ?? [])
        const ownerId = detail.ownerActorId || item.ownerActorId
        if (ownerId) {
          try {
            const actors = await getBackend().actors.listActorDirectory(teamId)
            const match = actors.find((a) => a.id === ownerId)
            setOwnerLabel(match?.display_name?.trim() || ownerId.slice(0, 8))
          } catch {
            setOwnerLabel(ownerId.slice(0, 8))
          }
        } else {
          setOwnerLabel(null)
        }
      } catch {
        if (!cancelled) {
          setVersions([])
          setOwnerLabel(item.ownerActorId ? item.ownerActorId.slice(0, 8) : null)
        }
      } finally {
        if (!cancelled) setVersionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item, teamId, slug])

  const dirty = content !== baseline

  const handleSave = React.useCallback(async () => {
    if (!item || !workspacePath || saving) return
    setSaving(true)
    try {
      const saved = await putDaemonSkill(encodeWorkspaceId(workspacePath), item.slug, {
        content,
        dirPath: item.dirPath,
        filename: item.filename,
      })
      if (saved === null) throw new Error('daemon rejected the update')
      await loadSection('skills', { force: true })
      // Re-check the pack against its baseline right away. Saving is what makes
      // a team pack differ from the version it was installed at, and "differs"
      // is the state the conflict bar renders — which is where the only entry
      // to publishing a new version lives. Leaving it to the next reconcile
      // tick meant the author saved, saw nothing change, found no way to share
      // the edit, and waited up to ten minutes to be told there was one.
      await reconcileSkills().catch(() => {})
    } catch (e) {
      toast.error(t('teamShare.saveFailed', 'Save failed: {{msg}}', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }, [item, workspacePath, saving, content, loadSection, reconcileSkills, t])

  const runInstall = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      await installSkill(item.slug)
      toast.success(t('teamShare.skillInstalled', 'Installed'))
    } catch (e) {
      if (e instanceof SkillMutationRefreshError) {
        toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
        return
      }
      // The installer refuses to overwrite a pack with local edits. That is a
      // state to explain, not a failure to report — the conflict bar renders as
      // soon as the reconcile records it.
      toast.error(
        isSkillDirtyConflict(e)
          ? t('teamShare.skillConflictTitle', 'Local changes — updates paused')
          : t('teamShare.skillInstallFailed', 'Install failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, installSkill, retrySkillsRuntimeRefresh, t])

  const runUninstall = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    setConfirmAction(null)
    try {
      await uninstallSkill(item.slug)
      toast.success(t('teamShare.skillUninstalled', 'Uninstalled'))
    } catch (e) {
      if (e instanceof SkillMutationRefreshError) {
        toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
        return
      }
      toast.error(
        t('teamShare.skillUninstallFailed', 'Uninstall failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, uninstallSkill, retrySkillsRuntimeRefresh, t])

  const runDelete = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    setConfirmAction(null)
    try {
      await deletePersonalSkill(item.slug)
      toast.success(t('teamShare.skillDeleted', 'Deleted'))
    } catch (e) {
      if (e instanceof SkillMutationRefreshError) {
        toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
        return
      }
      toast.error(
        t('teamShare.skillDeleteFailed', 'Delete failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, deletePersonalSkill, retrySkillsRuntimeRefresh, t])

  const runShare = React.useCallback(
    async (input: {
      slug: string
      summary: string
      category: TeamSkillCategory
      whenToUse: string
      whenNotToUse: string
      changelog: string
    }) => {
      if (!item || busy) return
      setBusy(true)
      try {
        const retiredPath = await sharePersonalSkill(item.slug, input)
        setShareOpen(false)
        toast.success(
          retiredPath
            ? t(
                'teamShare.skillSharedAndRetired',
                'Shared. Your personal copy was set aside — the team version is the one that stays up to date.',
              )
            : t('teamShare.skillShareSuccess', 'Shared and installed'),
          retiredPath
            ? {
                duration: 30_000,
                action: {
                  label: t('teamShare.skillKeepMine', 'Keep mine'),
                  onClick: () => {
                    void restoreDiscardedSkill(retiredPath, `${input.slug}-mine`).catch((e) => {
                      if (e instanceof SkillMutationRefreshError) {
                        toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
                        return
                      }
                      toast.error(
                        t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
                          msg: e instanceof Error ? e.message : String(e),
                        }),
                      )
                    })
                  },
                },
              }
            : undefined,
        )
      } catch (e) {
        toast.error(
          e instanceof SkillSlugTakenError
            ? t(
                'teamShare.skillShareSlugTaken',
                'The team already has a skill called {{slug}}. Pick another name, or publish a new version of the existing one.',
                { slug: e.slug },
              )
            : t('teamShare.skillShareFailed', 'Share failed: {{msg}}', {
                msg: e instanceof Error ? e.message : String(e),
              }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, sharePersonalSkill, restoreDiscardedSkill, retrySkillsRuntimeRefresh, t],
  )

  const runPublishVersion = React.useCallback(
    async (input: {
      changelog: string
      summary: string
      category: TeamSkillCategory
      whenToUse: string
      whenNotToUse: string
      requires: string[]
    }) => {
      if (!item || busy) return
      if (item.upstreamSubscribed) {
        const ok = window.confirm(
          t(
            'teamShare.marketplaceDetachOnPublish',
            '发布团队版本会断开与市场的订阅，之后市场更新不再自动同步。继续？',
          ),
        )
        if (!ok) return
      }
      setBusy(true)
      try {
        await publishSkillVersion(item.slug, input)
        setPublishOpen(false)
        toast.success(t('teamShare.skillPublished', 'Published'))
      } catch (e) {
        if (e instanceof SkillPublishedRefreshError) {
          setPublishOpen(false)
          toast.error(
            t(
              'teamShare.skillPublishedRefreshFailed',
              'Skill v{{v}} 已发布，本机刷新失败。请重试刷新。',
              { v: e.version },
            ),
            {
              action: {
                label: t('teamShare.skillRetryRefresh', 'Retry refresh'),
                onClick: () => {
                  void retrySkillsRuntimeRefresh()
                    .then(() =>
                      toast.success(t('teamShare.skillRefreshRetried', 'Runtime refreshed')),
                    )
                    .catch((retryError) =>
                      toast.error(
                        t('teamShare.skillRetryRefreshFailed', 'Runtime refresh failed: {{msg}}', {
                          msg: retryError instanceof Error ? retryError.message : String(retryError),
                        }),
                      ),
                    )
                },
              },
            },
          )
          return
        }
        if (e instanceof StaleDirtySkillPublishError) {
          toast.error(
            t(
              'teamShare.skillPublishStaleDirty',
              'Your draft is behind the team. Apply the latest version, fork, or discard before publishing.',
            ),
          )
          return
        }
        if (e instanceof StaleTeamSkillPublishError) {
          toast.error(
            t(
              'teamShare.skillPublishStaleBase',
              'Someone else published while you were editing. Your draft is kept — refresh and resolve the conflict.',
            ),
          )
          return
        }
        toast.error(
          t('teamShare.skillPublishFailed', 'Publish failed: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, publishSkillVersion, retrySkillsRuntimeRefresh, t],
  )

  const undoAction = React.useCallback(
    (trashedPath: string, slug: string) => ({
      label: t('common.undo', 'Undo'),
      onClick: () => {
        void restoreDiscardedSkill(trashedPath, slug).catch((e) => {
          if (e instanceof SkillMutationRefreshError) {
            toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
            return
          }
          toast.error(
            t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
          )
        })
      },
    }),
    [restoreDiscardedSkill, retrySkillsRuntimeRefresh, t],
  )

  const runDiscard = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      const trashedPath = await discardLocalSkill(item.slug)
      // Undo instead of a confirmation dialog: the dialog taxes everyone to
      // guard against a rare misclick, while the undo guards the misclick and
      // costs the other 99% nothing. The bytes are already saved aside, so this
      // is honest rather than optimistic.
      toast.success(t('teamShare.skillDiscarded', 'Local changes discarded'), {
        action: undoAction(trashedPath, item.slug),
      })
    } catch (e) {
      if (e instanceof SkillMutationRefreshError) {
        toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
        return
      }
      if (e instanceof SkillRuntimeRefreshError) {
        toast.error(
          t(
            'teamShare.skillSavedRefreshFailed',
            'Skill 已保存，但新会话可能暂时仍使用旧缓存。{{msg}}',
            { msg: e.message },
          ),
        )
        return
      }
      // A discard that got as far as moving the edits aside still has to offer
      // the undo — that path is where the user most needs it, and it is exactly
      // where a plain error toast would leave their work stranded in a
      // directory they cannot see.
      const stranded = e instanceof SkillDiscardIncompleteError ? e : null
      toast.error(
        stranded
          ? t('teamShare.skillDiscardIncomplete', 'Local changes set aside, but the team version could not be downloaded. It will arrive on the next sync.')
          : t('teamShare.skillDiscardFailed', 'Discard failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
        stranded
          ? { duration: 30_000, action: undoAction(stranded.trashedPath, item.slug) }
          : undefined,
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, discardLocalSkill, undoAction, retrySkillsRuntimeRefresh, t])

  const runFork = React.useCallback(
    async (newSlug: string) => {
      if (!item || busy) return
      setBusy(true)
      try {
        await forkSkill(item.slug, newSlug)
        setForkOpen(false)
        toast.success(t('teamShare.skillForked', 'Saved as {{slug}}', { slug: newSlug }))
      } catch (e) {
        if (e instanceof SkillMutationRefreshError) {
          toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
          return
        }
        toast.error(
          t('teamShare.skillForkFailed', 'Save failed: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, forkSkill, retrySkillsRuntimeRefresh, t],
  )

  const runKeepArchived = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      await keepArchivedCopy(item.slug, `${item.slug}-mine`)
      toast.success(t('teamShare.skillForked', 'Saved as {{slug}}', { slug: `${item.slug}-mine` }))
    } catch (e) {
      if (e instanceof SkillMutationRefreshError) {
        toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
        return
      }
      toast.error(
        t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, keepArchivedCopy, retrySkillsRuntimeRefresh, t])

  const runRevert = React.useCallback(
    (version: number) => {
      if (!item || busy) return
      const expectedLatest = item.latestVersion ?? 0
      setBusy(true)
      void revertSkillVersion(item.slug, version, expectedLatest)
        .then(() =>
          toast.success(t('teamShare.skillReverted', 'Restored v{{v}} as the current version', { v: version })),
        )
        .catch((e) => {
          if (e instanceof SkillMutationRefreshError) {
            toastSkillMutationRefreshFailed(t, e, retrySkillsRuntimeRefresh)
            return
          }
          if (e instanceof SkillRuntimeRefreshError) {
            toast.error(
              t(
                'teamShare.skillSavedRefreshFailed',
                'Skill 已保存，但新会话可能暂时仍使用旧缓存。{{msg}}',
                { msg: e.message },
              ),
            )
            return
          }
          if (e instanceof StaleTeamSkillPublishError) {
            toast.error(
              t(
                'teamShare.skillPublishStaleBase',
                'Someone else published while you were editing. Your draft is kept — refresh and resolve the conflict.',
              ),
            )
            return
          }
          toast.error(
            t('teamShare.skillRevertFailed', 'Restore failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
          )
        })
        .finally(() => setBusy(false))
    },
    [item, busy, revertSkillVersion, retrySkillsRuntimeRefresh, t],
  )

  const openDiff = React.useCallback(() => {
    if (!item) return
    setDiffOpen(true)
    setDiffTab('local')
    setDiffLoading(true)
    setTeamDiffLoading(false)
    setDiffs(null)
    setTeamDiffs(null)
    const baseVersion = localState?.installedVersion
      ? Number(localState.installedVersion)
      : item.installedVersion
    const latestVersion = item.latestVersion
    const stale =
      localState?.state === 'stale_dirty' &&
      baseVersion != null &&
      latestVersion != null &&
      latestVersion > baseVersion
    void loadSkillDiff(item.slug)
      .then(setDiffs)
      .catch((e) => {
        setDiffs([])
        toast.error(
          t('teamShare.skillDiffFailed', 'Could not load changes: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      })
      .finally(() => setDiffLoading(false))
    if (stale && baseVersion != null && latestVersion != null) {
      setTeamDiffLoading(true)
      void loadSkillTeamUpdatesDiff(item.slug, baseVersion, latestVersion)
        .then(setTeamDiffs)
        .catch(() => setTeamDiffs([]))
        .finally(() => setTeamDiffLoading(false))
    }
  }, [item, localState, loadSkillDiff, loadSkillTeamUpdatesDiff, t])

  const runRebaseOnLatest = React.useCallback(() => {
    if (!item || busy) return
    const latest = item.latestVersion
    const ok = window.confirm(
      t(
        'teamShare.skillRebaseConfirm',
        'Your draft moves to recovery trash and this machine installs team v{{v}}. Continue?',
        { v: latest },
      ),
    )
    if (!ok) return
    setBusy(true)
    void rebaseSkillOnLatest(item.slug)
      .then((trashedPath) =>
        toast.success(t('teamShare.skillRebased', 'Applied team v{{v}}', { v: latest }), {
          action: undoAction(trashedPath, item.slug),
        }),
      )
      .catch((e) => {
        if (e instanceof SkillDiscardIncompleteError) {
          toast.error(t('teamShare.skillRebasePartial', 'Draft archived; team copy will sync shortly.'), {
            action: undoAction(e.trashedPath, item.slug),
          })
          return
        }
        toast.error(
          t('teamShare.skillRebaseFailed', 'Could not apply team version: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      })
      .finally(() => setBusy(false))
  }, [item, busy, rebaseSkillOnLatest, t, undoAction])

  const loadDraftMetadata = React.useCallback(
    () => loadSkillDraftMetadata(item?.slug ?? slug),
    [loadSkillDraftMetadata, item?.slug, slug],
  )

  if (!item) return null

  const conflicted =
    localState?.state === 'dirty' || localState?.state === 'stale_dirty'
  const isRegistry = item.origin === 'registry'
  const isPersonal = item.kind === 'personal'
  const isBuiltin = isPersonal && item.personalSource === 'builtin'
  // `dirPath` is only ever populated when the selected Agent is this machine
  // (see `localSkillFiles` in the store): a remote Agent's files live on another
  // disk and the RPC inventory carries neither path nor content. So these two
  // read as "this Agent is local AND the pack is here", which is exactly the
  // precondition for editing it and for packing it up to publish.
  const canEdit = Boolean(item.dirPath && item.filename && (item.kind === 'personal' || item.installed))
  const canShare = isPersonal && Boolean(item.dirPath && item.filename)
  const latestChangelog = [...versions].sort((a, b) => b.version - a.version)[0]?.changelog
  const baseVersion = localState?.installedVersion
    ? Number(localState.installedVersion)
    : item.installedVersion
  const isStaleDirty = localState?.state === 'stale_dirty'
  // Any team member can publish and revert: the registry is team property, and
  // the gate on a new version is the required fields, not an approver. `owner`
  // stays on the row as the answer to "who is responsible for this" — it is
  // displayed, not enforced (see the member-writes migration and the pg-repo
  // header). stale_dirty must rebase/fork/discard first — publishing would
  // overwrite team versions the author never saw.
  const canPublish = isRegistry && !isStaleDirty
  const showTeamDiffTab =
    isStaleDirty &&
    baseVersion != null &&
    item.latestVersion != null &&
    item.latestVersion > baseVersion

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          <Sparkles className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.skills', 'Skills')}
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-bold text-foreground">{item.name}</span>
            {item.marketplaceOrigin === 'marketplace' && (
              <button
                type="button"
                className="shrink-0 rounded border border-border bg-paper px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
                onClick={() =>
                  openDetail({
                    kind: 'marketplace-item',
                    slug: item.upstreamSlug || item.slug,
                  })
                }
              >
                {t('teamShare.marketplaceBadge', '市场')}
              </button>
            )}
            {item.status === 'deprecated' && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <Archive className="h-3 w-3" />
                {t('teamShare.skillDeprecated', 'Deprecated')}
              </span>
            )}
            {isPersonal && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t('teamShare.skillPersonalBadge', 'Personal')}
              </span>
            )}
          </div>
          {item.marketplaceOrigin === 'marketplace' && (
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
              <span>
                {item.upstreamSubscribed
                  ? t('teamShare.marketplaceFollowingShort', '跟随市场 v{{v}}', {
                      v: item.latestVersion,
                    })
                  : t('teamShare.marketplaceDetachedShort', '已断开 · 停在市场版本')}
              </span>
              {item.upstreamSubscribed ? (
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => {
                    void detachMarketplaceSkill(item.slug)
                      .then(() =>
                        toast.success(t('teamShare.marketplaceDetachedToast', '已断开订阅')),
                      )
                      .catch((e) =>
                        toast.error(e instanceof Error ? e.message : String(e)),
                      )
                  }}
                >
                  {t('teamShare.marketplaceDetach', '断开订阅')}
                </button>
              ) : null}
            </div>
          )}
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{item.invocationName}</span>

        {item.kind === 'team-available' && (
          <Button
            type="button"
            onClick={() => void runInstall()}
            disabled={busy || agentOffline || item.status === 'deprecated'}
            className={cn(
              'h-8 gap-1.5 text-[13px] font-semibold',
              item.status === 'deprecated'
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'bg-coral text-white hover:bg-coral/90',
            )}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('teamShare.skillInstall', 'Install')}
          </Button>
        )}

        {item.kind === 'team-installed' && (
          <>
            {/*
              No update button. Under auto-follow, being behind is a state that
              clears itself within a reconcile tick, so it is reported and not
              actioned — a button here would ask the user to do something that
              is already happening. The one case that genuinely needs a person
              is a local edit, and that gets the conflict bar below instead.
            */}
            {item.hasUpdate && !conflicted && !syncError && (
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {t('teamShare.skillUpdatingTo', 'updating to v{{v}}…', { v: item.latestVersion })}
              </span>
            )}
            {/*
              A sync that keeps failing has to say so. "updating to v3…" is
              true for ten minutes and a lie after that, and with no update
              button left there is nowhere else for the failure to appear —
              the member would run a retired version indefinitely, told only
              that an update was on its way.
            */}
            {syncError && !conflicted && (
              <button
                type="button"
                onClick={() => void reconcileSkills()}
                title={syncError}
                className="flex shrink-0 items-center gap-1 text-[11px] text-foreground underline-offset-2 hover:underline"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('teamShare.skillSyncFailedRetry', 'Update failed — retry')}
              </button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmAction('uninstall')}
              disabled={busy || agentOffline}
              className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('teamShare.skillUninstall', 'Uninstall')}
            </Button>
          </>
        )}

        {isPersonal && (
          <>
            {!isBuiltin ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmAction('delete')}
                disabled={busy || agentOffline}
                className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('teamShare.skillDelete', 'Delete')}
              </Button>
            ) : null}
            {canShare ? (
              <Button
                type="button"
                onClick={() => setShareOpen(true)}
                disabled={busy}
                className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
              >
                <Share2 className="h-3.5 w-3.5" />
                {t('teamShare.skillShare', 'Share')}
              </Button>
            ) : null}
          </>
        )}

        {canEdit && (
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className={cn(
              'h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90',
              !dirty && 'opacity-50',
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('teamShare.save', 'Save')}
          </Button>
        )}
      </div>

      {/*
        Another registry's pack is sitting on this slug. Auto-follow stops, and
        it has to say why: every registry installs into the same root, so the
        member sees "installed" here while the directory holds something else
        entirely, and none of the conflict exits apply — there is nothing of
        theirs to publish, fork, or discard.
      */}
      {localState?.state === 'foreign' && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillForeign', 'A skill from another source already owns this name')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillForeignHint',
                'Nothing was changed. Uninstall the other copy, or rename one of them, and this will install on the next sync.',
              )}
            </p>
          </div>
        </div>
      )}

      {/*
        The team deleted this skill and auto-follow could not take the pack away,
        because the member had edited it. Their copy is theirs now — but nothing
        else on this screen says so: the row has quietly re-labelled itself
        "personal" (the agent inventory reports any unclaimed directory that
        way), which reads as though it was never a team skill at all.
      */}
      {retired === 'kept' && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillRetiredKeptTitle', '团队已移除这个技能')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillRetiredKeptBody',
                '因为你改过它，本地这份保留了下来，现在是你自己的技能，不再跟随团队更新。',
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => dismissRetired(item.slug)}
                disabled={busy}
                className="h-8 text-[13px] text-muted-foreground hover:text-foreground"
              >
                {t('common.dismiss', 'Dismiss')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/*
        Auto-follow needed this path and something unrelated was sitting on it.
        Overwriting is right when a person clicks install; this arrived on its
        own, possibly seconds after they signed in on a new machine, so the file
        was set aside instead and they get to decide.
      */}
      {recoveries.length > 0 && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillDraftRecoveryTitle', 'Recent draft recoveries')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillDraftRecoveryBody',
                'Discarded drafts are kept for 7 days. Restore one to pick up where you left off.',
              )}
            </p>
            <ul className="mt-2 space-y-2">
              {recoveries.map((rec) => (
                <li
                  key={rec.path}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-border-soft bg-background px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-medium text-foreground">{rec.slug}</p>
                    <p className="font-mono text-[11px] text-faint">
                      {new Date(rec.at).toLocaleString()}
                      {rec.baseVersion != null ? ` · v${rec.baseVersion}` : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void restoreDiscardedSkill(rec.path, rec.slug).catch((e) =>
                        toast.error(
                          t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
                            msg: e instanceof Error ? e.message : String(e),
                          }),
                        ),
                      )
                    }
                    className="h-8 shrink-0 text-[13px] text-muted-foreground hover:text-foreground"
                  >
                    {t('teamShare.skillDraftRecoveryRestore', 'Restore draft')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {archivedPath && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillArchivedTitle', 'A skill of yours had this name')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillArchivedBody',
                'The team version now owns {{slug}}. Your file was set aside, not deleted.',
                { slug: item.slug },
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => void runKeepArchived()}
                disabled={busy}
                className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" />
                {t('teamShare.skillArchivedKeep', 'Keep mine as {{slug}}', {
                  slug: `${item.slug}-mine`,
                })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => dismissArchived(item.slug)}
                disabled={busy}
                className="h-8 text-[13px] text-muted-foreground hover:text-foreground"
              >
                {t('common.dismiss', 'Dismiss')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {conflicted && (
        <ConflictBar
          modified={localState?.modified ?? []}
          added={localState?.added ?? []}
          deleted={localState?.deleted ?? []}
          installedVersion={baseVersion}
          latestVersion={item.latestVersion}
          busy={busy}
          canPublish={canPublish}
          isStaleDirty={isStaleDirty}
          source={localState?.source ?? 'member'}
          onViewDiff={openDiff}
          onPublish={() => setPublishOpen(true)}
          onFork={() => setForkOpen(true)}
          onDiscard={() => void runDiscard()}
          onRebaseOnLatest={() => void runRebaseOnLatest()}
        />
      )}

      {item.status === 'deprecated' && item.supersededBy && (
        <button
          type="button"
          onClick={() => select('skills', item.supersededBy!)}
          className="flex w-full items-center gap-2 border-b border-border bg-muted/40 px-5 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted/60"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('teamShare.skillSupersededBy', 'Deprecated — use {{slug}} instead', {
            slug: item.supersededBy,
          })}
        </button>
      )}

      {item.summary && (
        <div className="border-b border-border px-5 py-3 text-[13px] text-foreground">{item.summary}</div>
      )}
      <MetaRow item={item} ownerLabel={ownerLabel} />
      <UsageBoundary item={item} />
      {isRegistry && (
        <VersionHistory
          versions={versions}
          loading={versionsLoading}
          installedVersion={item.installedVersion}
          canRevert={canPublish}
          reverting={busy}
          onRevert={runRevert}
        />
      )}

      <div className="min-h-0 flex-1">
        {canEdit ? (
          <Suspense
            fallback={
              <div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>
            }
          >
            <CodeEditor
              content={content}
              filename="SKILL.md"
              filePath={`${item.dirPath}/${item.filename}/SKILL.md`}
              onChange={setContent}
              isDark={isDark}
            />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
              {/*
                An installed skill with no local copy is not "not installed" —
                it is on the selected Agent's disk, which is another machine.
                Telling that user to install it is a dead end: installing again
                changes nothing, and the pane stays read-only either way.
              */}
              {item.kind === 'team-installed' && item.hasUpdate && !item.dirPath
                ? t(
                    'teamShare.skillSyncingBody',
                    '正在同步到 v{{v}}，完成后即可查看和编辑文件。',
                    { v: item.latestVersion ?? item.installedVersion ?? '?' },
                  )
                : item.installed || isPersonal
                  ? t(
                      'teamShare.skillOnRemoteAgentBody',
                      '这个 Skill 装在所选 Agent 的机器上，远程暂不支持查看和编辑内容。',
                    )
                  : t(
                      'teamShare.skillNotInstalledBody',
                      'Install this skill to read and edit its package contents on disk.',
                    )}
            </p>
            {latestChangelog && (
              <p className="max-w-md text-[12px] leading-relaxed text-faint">
                <span className="font-medium text-muted-foreground">
                  {t('teamShare.skillLatestChangelog', 'Latest changelog')}
                  {': '}
                </span>
                {latestChangelog}
              </p>
            )}
            {item.kind === 'team-available' && (
              <Button
                type="button"
                onClick={() => void runInstall()}
                disabled={busy || agentOffline || item.status === 'deprecated'}
                className="mt-1 h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {t('teamShare.skillInstall', 'Install')}
              </Button>
            )}
          </div>
        )}
      </div>

      {canShare && (
        <ShareSheet
          item={item}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          onSubmit={runShare}
          busy={busy}
          takenSlugs={registrySlugs}
        />
      )}

      <PublishVersionSheet
        item={item}
        nextVersion={(item.latestVersion ?? 0) + 1}
        baseVersion={baseVersion}
        open={publishOpen}
        busy={busy}
        changePreview={
          conflicted
            ? {
                modified: localState?.modified ?? [],
                deleted: localState?.deleted ?? [],
                added: localState?.added ?? [],
              }
            : undefined
        }
        onLoadDraftMetadata={loadDraftMetadata}
        onClose={() => setPublishOpen(false)}
        onSubmit={runPublishVersion}
      />
      <ForkSheet
        slug={item.slug}
        open={forkOpen}
        busy={busy}
        onClose={() => setForkOpen(false)}
        onSubmit={runFork}
      />
      {diffOpen && (
        <DiffSheet
          slug={item.slug}
          diffs={diffs}
          teamDiffs={teamDiffs}
          loading={diffLoading}
          teamLoading={teamDiffLoading}
          showTeamTab={showTeamDiffTab}
          diffTab={diffTab}
          onDiffTabChange={setDiffTab}
          isDark={isDark}
          onClose={() => setDiffOpen(false)}
        />
      )}

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === 'delete'
                ? t('teamShare.skillDeleteTitle', 'Delete Skill')
                : t('teamShare.skillUninstallTitle', 'Uninstall Skill')}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === 'delete'
                ? t(
                    'teamShare.skillDeleteConfirm',
                    'Are you sure you want to delete "{{name}}"? This permanently removes the skill from disk and cannot be undone.',
                    { name: item.name },
                  )
                : t(
                    'teamShare.skillUninstallConfirm',
                    'Uninstall "{{name}}"? You can install it again from Team Available later.',
                    { name: item.name },
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmAction(null)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void (confirmAction === 'delete' ? runDelete() : runUninstall())
              }
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {confirmAction === 'delete'
                ? t('teamShare.skillDelete', 'Delete')
                : t('teamShare.skillUninstall', 'Uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
