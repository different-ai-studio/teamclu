import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalShell } from './ModalShell'

export function ForkSheet({
  slug,
  open,
  busy,
  onClose,
  onSubmit,
}: {
  slug: string
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (newSlug: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [newSlug, setNewSlug] = React.useState(`${slug}-mine`)

  React.useEffect(() => {
    if (open) setNewSlug(`${slug}-mine`)
  }, [open, slug])

  if (!open) return null

  return (
    <ModalShell
      title={t('teamShare.skillForkTitle', 'Save as personal skill')}
      // The rename is not a preference. Local skills outrank team skills in the
      // loader, so a fork keeping the original slug would shadow the team copy
      // and silently undo the auto-follow this action exists to preserve.
      hint={t(
        'teamShare.skillForkHint',
        'Keeps your edits under a new name. The team version goes back to updating automatically.',
      )}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="h-8 text-[13px]">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!newSlug.trim() || newSlug.trim() === slug || busy}
            onClick={() => void onSubmit(newSlug.trim())}
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
            {t('teamShare.skillForkSubmit', 'Save a copy')}
          </Button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillShareSlug', 'Slug')}
        </span>
        <input
          value={newSlug}
          onChange={(e) => setNewSlug(e.target.value)}
          autoFocus
          className="w-full rounded-[8px] border border-border bg-background px-3 py-2 font-mono text-[13px] outline-none focus:border-coral/60"
        />
      </label>
    </ModalShell>
  )
}
