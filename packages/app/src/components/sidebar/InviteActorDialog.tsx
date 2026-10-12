import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { UpgradeToOrgDialog } from '@/components/auth/UpgradeToOrgDialog'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamPermissions } from '@/lib/team/team-permissions'
import { TeamJoinLinkSection } from '@/components/sidebar/TeamJoinLinkSection'

interface InviteActorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId?: string | null
}

export function InviteActorDialog({ open, onOpenChange, teamId }: InviteActorDialogProps) {
  const { t } = useTranslation()
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const effectiveTeamId = currentTeamId ?? teamId ?? null
  const { canManageTeam } = useTeamPermissions()
  // Set when the join link is blocked because the team is still in the shared
  // default org (403 upgrade_required).
  const [needsUpgrade, setNeedsUpgrade] = React.useState(false)
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)

  const reset = React.useCallback(() => {
    setNeedsUpgrade(false)
    setUpgradeOpen(false)
  }, [])

  React.useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('invite.title', 'Invite to team')}</DialogTitle>
          <DialogDescription>
            {t('invite.description', 'Share the join link to add someone.')}
          </DialogDescription>
        </DialogHeader>

        {needsUpgrade ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {t(
                'invite.upgradeRequired',
                '当前团队还在公共组织下，只能自己使用。升级账号、创建你自己的团队后即可邀请成员。',
              )}
            </p>
          </div>
        ) : canManageTeam && effectiveTeamId ? (
          <TeamJoinLinkSection
            teamId={effectiveTeamId}
            onUpgradeRequired={() => setNeedsUpgrade(true)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('invite.managersOnly', 'Only a team owner or admin can invite people.')}
          </p>
        )}

        <DialogFooter>
          {needsUpgrade ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('common.later', '稍后')}
              </Button>
              <Button onClick={() => setUpgradeOpen(true)}>
                {t('invite.upgradeButton', '升级账号')}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      <UpgradeToOrgDialog
        open={upgradeOpen}
        onOpenChange={(o) => {
          setUpgradeOpen(o)
          // After a successful upgrade the team leaves the default org, so the
          // invite path works — clear the prompt and let the user retry.
          if (!o) setNeedsUpgrade(false)
        }}
      />
    </Dialog>
  )
}
