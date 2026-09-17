import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function DeprecateTeamSkillDialog({
  slug,
  open,
  busy = false,
  publishedSlugs,
  onCancel,
  onConfirm,
}: {
  slug: string
  open: boolean
  busy?: boolean
  publishedSlugs: string[]
  onCancel: () => void
  onConfirm: (supersededBy: string | null) => void
}) {
  const { t } = useTranslation()
  const [replacement, setReplacement] = React.useState('')

  React.useEffect(() => {
    setReplacement('')
  }, [slug, open])

  const handleConfirm = () => {
    onConfirm(replacement || null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('teamShare.skillDeprecateTitle', '退役团队 Skill')}</DialogTitle>
          <DialogDescription>
            {t(
              'teamShare.skillDeprecateConfirm',
              '将「{{name}}」标为退役？已安装的副本会留着，直到有人卸载或从团队移除。',
              { name: slug },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="deprecate-replacement" className="text-[12px] text-muted-foreground">
            {t('teamShare.skillDeprecateReplacement', '替代 skill（可选）')}
          </label>
          <select
            id="deprecate-replacement"
            value={replacement}
            disabled={busy}
            onChange={(e) => setReplacement(e.target.value)}
            className="h-9 rounded-md border border-border bg-paper px-3 text-[13px] text-foreground"
          >
            <option value="">
              {t('teamShare.skillDeprecateNoReplacement', '无替代')}
            </option>
            {publishedSlugs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={handleConfirm}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('teamShare.skillDeprecate', '退役')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
