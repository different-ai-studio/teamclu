import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { DeprecateTeamSkillDialog } from './DeprecateTeamSkillDialog'

export function TeamSkillAdminActions({
  canManageTeam,
  origin,
  status,
  slug,
  publishedSlugs,
  busy = false,
  onDeprecate,
  onRestore,
  onDelete,
}: {
  canManageTeam: boolean
  origin: string
  status: 'draft' | 'published' | 'deprecated' | string
  slug: string
  publishedSlugs: string[]
  busy?: boolean
  onDeprecate: (supersededBy: string | null) => void
  onRestore: () => void
  onDelete: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [deprecateOpen, setDeprecateOpen] = React.useState(false)

  if (!canManageTeam || origin !== 'registry') return null

  const handleDeprecateConfirm = (supersededBy: string | null) => {
    setDeprecateOpen(false)
    onDeprecate(supersededBy)
  }

  return (
    <div className="border-b border-border px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {status === 'published' && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setDeprecateOpen(true)}
            className="h-8 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {t('teamShare.skillDeprecate', '退役')}
          </Button>
        )}
        {status === 'deprecated' && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onRestore}
            className="h-8 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {t('teamShare.skillRestorePublished', '恢复发布')}
          </Button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="text-[13px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
        >
          {t('teamShare.skillDeleteTeamFromDetail', '从团队移除…')}
        </button>
      </div>
      <DeprecateTeamSkillDialog
        slug={slug}
        open={deprecateOpen}
        busy={busy}
        publishedSlugs={publishedSlugs}
        onCancel={() => setDeprecateOpen(false)}
        onConfirm={handleDeprecateConfirm}
      />
    </div>
  )
}
