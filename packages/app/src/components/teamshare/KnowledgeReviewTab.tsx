import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  getKnowledgeCandidate,
  isAlreadyExistsError,
  publishKnowledgeCandidate,
} from '@/lib/knowledge/inbox-client'
import type {
  KnowledgeCandidate,
  KnowledgeSuggestion,
  KnowledgeSuggestionKind,
} from '@/lib/knowledge/inbox-types'
import { composeKnowledgeDraftFromSelection } from '@/lib/knowledge/session-knowledge-draft'
import { encodeKnowledgeReviewTarget } from '@/lib/tabs/teamshare-target'
import { useTabsStore } from '@/stores/tabs'
import { useKnowledgeInboxStore } from '@/stores/knowledge-inbox'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useWorkspaceStore } from '@/stores/workspace'

const KIND_LABEL: Record<KnowledgeSuggestionKind, string> = {
  decision: '结论',
  fact: '要点',
  followup: '后续',
}

function vaultAbsPath(syncRoot: string | null, rel: string): string | null {
  if (!syncRoot) return null
  const clean = rel.replace(/^\/+/, '')
  return `${syncRoot.replace(/\/+$/, '')}/knowledge/${clean}`
}

function composedBody(
  summary: string,
  suggestions: KnowledgeSuggestion[],
  selectedIds: ReadonlySet<string>,
): string {
  return (
    composeKnowledgeDraftFromSelection(summary, suggestions, selectedIds) ||
    '（请勾选建议，或直接改写正文。）'
  )
}

export function KnowledgeReviewTab({ candidateId }: { candidateId: string }) {
  const { t } = useTranslation()
  const closeWhere = useTabsStore((s) => s.closeWhere)
  const [candidate, setCandidate] = React.useState<KnowledgeCandidate | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState('')
  const [path, setPath] = React.useState('')
  const [body, setBody] = React.useState('')
  const [summary, setSummary] = React.useState('')
  const [suggestions, setSuggestions] = React.useState<KnowledgeSuggestion[]>([])
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [bodyDirty, setBodyDirty] = React.useState(false)
  const [overwrite, setOverwrite] = React.useState(false)
  const [busy, setBusy] = React.useState<'publish' | 'discard' | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void getKnowledgeCandidate(candidateId)
      .then((row) => {
        if (cancelled) return
        const items = row.suggestions ?? []
        const ids = new Set(items.map((item) => item.id))
        setCandidate(row)
        setTitle(row.title)
        setPath(row.suggestedPath || '')
        setSummary(row.summary ?? '')
        setSuggestions(items)
        setSelectedIds(ids)
        setBody(row.body)
        setBodyDirty(false)
        setLoadError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [candidateId])

  const closeTab = React.useCallback(() => {
    const target = encodeKnowledgeReviewTarget(candidateId)
    closeWhere((tab) => tab.type === 'native' && tab.target === target)
  }, [candidateId, closeWhere])

  const rewriteFromSelection = (ids: ReadonlySet<string>) => {
    setBody(composedBody(summary, suggestions, ids))
    setBodyDirty(false)
  }

  const onToggleSuggestion = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
    if (!bodyDirty) rewriteFromSelection(next)
  }

  const onLater = () => {
    closeTab()
  }

  const onDiscard = async () => {
    setBusy('discard')
    try {
      await useKnowledgeInboxStore.getState().remove(candidateId)
      toast.success(t('knowledgeReview.discarded', '已丢弃草稿'))
      closeTab()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const onPublish = async () => {
    const trimmedPath = path.trim()
    if (!trimmedPath) {
      toast.error(t('knowledgeReview.pathRequired', '请填写知识库路径'))
      return
    }
    setBusy('publish')
    try {
      const result = await publishKnowledgeCandidate(candidateId, {
        title: title.trim() || candidate?.title || 'untitled',
        content: body,
        path: trimmedPath,
        overwrite,
      })
      await useKnowledgeInboxStore.getState().load()
      const abs = vaultAbsPath(useTeamShareBrowserStore.getState().syncRoot, result.path)
      if (abs) await useWorkspaceStore.getState().selectFile(abs)
      if (result.teamSync === 'not-syncing') {
        toast.message(
          t('knowledgeReview.savedLocalOnly', '已写入本机，当前没有同步到团队'),
        )
      } else {
        toast.success(t('knowledgeReview.published', '已写入知识库'))
      }
      closeTab()
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        setOverwrite(false)
        toast.error(
          t('knowledgeReview.alreadyExists', '目标已存在。勾选覆盖后再写入。'),
        )
      } else {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(null)
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
        {loadError}
      </div>
    )
  }

  if (!candidate) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4" data-tauri-drag-region>
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">
          {t('knowledgeReview.kicker', '审稿')}
        </div>
        <div className="mt-1 text-[15px] font-bold text-foreground">
          {t('knowledgeReview.title', '写入知识库前先看一遍')}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          {t(
            'knowledgeReview.distillHint',
            '这是从会话里提炼的建议，不是聊天全文。勾选要留下的条目，再写入。',
          )}
        </div>
        {candidate.sessionId ? (
          <div className="mt-1 text-[12px] text-faint">
            {t('knowledgeReview.fromSession', '来自会话 {{id}}', {
              id: candidate.sessionId.slice(0, 8),
            })}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-foreground">
              {t('knowledgeReview.fieldTitle', '标题')}
            </span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-9 bg-paper text-[13.5px]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-foreground">
              {t('knowledgeReview.fieldPath', '知识库路径')}
            </span>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="20-domains/example.md"
              className="h-9 bg-paper font-mono text-[12px]"
            />
          </label>
          {suggestions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground">
                {t('knowledgeReview.suggestions', '提炼建议')}
              </span>
              <div className="flex flex-col gap-1 rounded-[8px] border border-border-soft bg-paper p-1.5">
                {suggestions.map((item) => (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-start gap-2 rounded-[6px] px-2 py-1.5 hover:bg-selected"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selectedIds.has(item.id)}
                      onChange={() => onToggleSuggestion(item.id)}
                    />
                    <span className="mt-px shrink-0 text-[10.5px] font-semibold tracking-[0.6px] text-faint">
                      {KIND_LABEL[item.kind]}
                    </span>
                    <span className="min-w-0 flex-1 text-[12.5px] leading-[1.6] text-foreground">
                      {item.text}
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="self-start text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => rewriteFromSelection(selectedIds)}
              >
                {t('knowledgeReview.rewriteBody', '按所选建议重写正文')}
              </button>
            </div>
          ) : null}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-foreground">
              {t('knowledgeReview.fieldBody', '正文')}
            </span>
            <textarea
              aria-label={t('knowledgeReview.fieldBody', '正文')}
              value={body}
              onChange={(e) => {
                setBody(e.target.value)
                setBodyDirty(true)
              }}
              rows={12}
              className={cn(
                'w-full resize-y rounded-[8px] border border-border bg-paper',
                'px-3 py-2.5 text-[13.5px] leading-[1.7] text-foreground',
                'outline-none focus-visible:border-foreground/20',
              )}
            />
          </label>
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            {t('knowledgeReview.overwrite', '覆盖已有页面')}
          </label>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-soft bg-paper px-6 py-3">
        <Button
          type="button"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void onDiscard()}
        >
          {t('knowledgeReview.discard', '丢弃')}
        </Button>
        <Button type="button" variant="ghost" disabled={busy !== null} onClick={onLater}>
          {t('knowledgeReview.later', '稍后')}
        </Button>
        <Button
          type="button"
          disabled={busy !== null}
          onClick={() => void onPublish()}
          className="bg-coral text-white hover:bg-coral/90"
        >
          {busy === 'publish' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t('knowledgeReview.publish', '写入知识库')
          )}
        </Button>
      </div>
    </div>
  )
}
