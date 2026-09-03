import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UpgradeToOrgDialog } from '@/components/auth/UpgradeToOrgDialog'
import { getBackend } from '@/lib/backend'
import { buildInviteDeeplink } from '@/lib/team/invite-deeplink'
import { cn } from '@/lib/utils'
import { useCurrentTeamStore } from '@/stores/current-team'

type InviteKind = 'member' | 'agent'
type TeamRole = 'member' | 'admin'

interface InviteCreated {
  token: string
  expiresAt: string
  deeplink: string
}

interface InviteActorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId?: string | null
}

export function InviteActorDialog({ open, onOpenChange, teamId }: InviteActorDialogProps) {
  const { t } = useTranslation()
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const effectiveTeamId = currentTeamId ?? teamId ?? null
  const [kind, setKind] = React.useState<InviteKind>('member')
  const [name, setName] = React.useState('')
  const [teamRole, setTeamRole] = React.useState<TeamRole>('member')
  // Optional. When either is filled the invitee sees this invite waiting for
  // them after signing in, so the link below becomes a convenience rather than
  // the only way in.
  const [email, setEmail] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [agentKind] = React.useState<string>('daemon')
  const [submitting, setSubmitting] = React.useState(false)
  const [invite, setInvite] = React.useState<InviteCreated | null>(null)
  // Set when the backend rejects a member invite because the team is still in
  // the shared default org (403 upgrade_required) — prompts an account upgrade.
  const [needsUpgrade, setNeedsUpgrade] = React.useState(false)
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)

  const reset = React.useCallback(() => {
    setKind('member')
    setName('')
    setTeamRole('member')
    setEmail('')
    setPhone('')
    setSubmitting(false)
    setInvite(null)
    setNeedsUpgrade(false)
    setUpgradeOpen(false)
  }, [])

  React.useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const trimmed = name.trim()
  const canSubmit = !!trimmed && !!effectiveTeamId && !submitting && invite == null

  const submit = async () => {
    if (!canSubmit) return
    if (!effectiveTeamId) return
    setSubmitting(true)
    try {
      const row = kind === 'member'
        ? await getBackend().teams.createTeamInvite({
            teamId: effectiveTeamId,
            kind: 'member',
            displayName: trimmed,
            teamRole,
            ttlSeconds: null,
            targetActorId: null,
            inviteEmail: email.trim() || null,
            invitePhone: phone.trim() || null,
          })
        : await getBackend().teams.createTeamInvite({
            teamId: effectiveTeamId,
            kind: 'agent',
            displayName: trimmed,
            agentKind,
            ttlSeconds: null,
            targetActorId: null,
          })
      if (!row.token) {
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg: 'empty response' }))
        return
      }
      setInvite({
        token: row.token,
        expiresAt: row.expiresAt ?? new Date(Date.now() + 604800 * 1000).toISOString(),
        // Not row.deeplink: that carries the backend's `amux://` scheme, which
        // no build registers with the OS.
        deeplink: buildInviteDeeplink(row.token),
      })
    } catch (e) {
      // Default-org teams are solo-only: inviting members requires upgrading the
      // account into its own org first (FC returns 403 upgrade_required). Surface
      // an upgrade prompt instead of a generic failure toast.
      const code = (e as { code?: unknown })?.code
      if (code === 'upgrade_required') {
        setNeedsUpgrade(true)
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg }))
      }
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
          <DialogTitle>{t('invite.title', 'Invite to team')}</DialogTitle>
          <DialogDescription>
            {invite
              ? t('invite.shareDescription', 'Share this link so they can join the team.')
              : t('invite.description', 'Create an invite link for a new teammate or agent.')}
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
        ) : !invite ? (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('invite.kindLabel', 'Kind')}
              </label>
              <div className="inline-flex gap-1 rounded-md bg-muted p-1">
                {(['member', 'agent'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      'rounded px-3 py-1 text-xs font-medium transition-colors',
                      kind === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                    disabled={submitting}
                  >
                    {k === 'member' ? t('invite.kindMember', 'Teammate') : t('invite.kindAgent', 'Agent')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('invite.nameLabel', 'Name')}
              </label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('invite.namePlaceholder', 'Display name')}
                disabled={submitting}
              />
            </div>
            {kind === 'member' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('invite.roleLabel', 'Role')}
                </label>
                <div className="inline-flex gap-1 rounded-md bg-muted p-1">
                  {(['member', 'admin'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setTeamRole(r)}
                      className={cn(
                        'rounded px-3 py-1 text-xs font-medium transition-colors',
                        teamRole === r ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                      disabled={submitting}
                    >
                      {r === 'member' ? t('invite.roleMember', 'Member') : t('invite.roleAdmin', 'Admin')}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {kind === 'member' && (
              <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                <p className="text-[11px] text-muted-foreground">
                  {t(
                    'invite.contactHint',
                    '填写邮箱或手机号后，对方登录时会直接看到这个邀请，不用你再发链接。',
                  )}
                </p>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('invite.emailLabel', 'Email (optional)')}
                  </label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('invite.emailPlaceholder', 'name@example.com')}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('invite.phoneLabel', 'Phone (optional)')}
                  </label>
                  <Input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={t('invite.phonePlaceholder', '13800138000')}
                    disabled={submitting}
                  />
                </div>
              </div>
            )}
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
          {needsUpgrade ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('common.later', '稍后')}
              </Button>
              <Button onClick={() => setUpgradeOpen(true)}>
                {t('invite.upgradeButton', '升级账号')}
              </Button>
            </>
          ) : !invite ? (
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
