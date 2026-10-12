import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getBackend } from '@/lib/backend'
import { buildInviteDeeplink } from '@/lib/team/invite-deeplink'
import { getEffectiveServerConfigSync } from '@/lib/config/server-config'
import { useCurrentTeamStore } from '@/stores/current-team'

interface InviteCreated {
  deeplink: string
  expiresAt: string
}

interface AnotherComputerAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AnotherComputerAgentDialog({ open, onOpenChange }: AnotherComputerAgentDialogProps) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const [name, setName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [invite, setInvite] = React.useState<InviteCreated | null>(null)

  const reset = React.useCallback(() => {
    setName('')
    setSubmitting(false)
    setInvite(null)
  }, [])

  React.useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const trimmed = name.trim()
  const canSubmit = !!trimmed && !!teamId && !submitting && invite == null

  const submit = async () => {
    if (!canSubmit || !teamId) return
    setSubmitting(true)
    try {
      const row = await getBackend().teams.createTeamInvite({
        teamId,
        kind: 'agent',
        displayName: trimmed,
        agentKind: 'daemon',
        ttlSeconds: null,
        targetActorId: null,
      })
      if (!row.token) {
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg: 'empty response' }))
        return
      }
      setInvite({
        deeplink: buildInviteDeeplink(row.token, getEffectiveServerConfigSync().cloudApiUrl),
        expiresAt: row.expiresAt ?? new Date(Date.now() + 604800 * 1000).toISOString(),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg }))
    } finally {
      setSubmitting(false)
    }
  }

  const copyLink = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.deeplink)
    } catch {
      toast.error(t('invite.copyFailed', 'Failed to copy invite link'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('actors.anotherComputer', 'Run on another computer')}</DialogTitle>
          <DialogDescription>
            {t(
              'actors.anotherComputerHint',
              'Open the link on that computer and it joins this team as that machine\'s agent.',
            )}
          </DialogDescription>
        </DialogHeader>

        {!invite ? (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="another-computer-name">
                {t('invite.nameLabel', 'Name')}
              </label>
              <Input
                id="another-computer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('invite.namePlaceholder', 'Display name')}
                disabled={submitting}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('invite.linkLabel', 'Invite link')}
              </label>
              <div className="flex items-center gap-2">
                <Input value={invite.deeplink} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => void copyLink()} title={t('invite.copy', 'Copy')}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('invite.expiresAt', 'Expires {{date}}', {
                date: new Date(invite.expiresAt).toLocaleString(),
              })}
            </p>
          </div>
        )}

        <DialogFooter>
          {!invite ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button onClick={() => void submit()} disabled={!canSubmit}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('invite.createButton', 'Create invite')}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
