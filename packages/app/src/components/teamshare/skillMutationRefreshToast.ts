import { toast } from 'sonner'
import type { SkillMutationAction, SkillMutationRefreshError } from '@/stores/team-share-browser'

type Translate = (key: string, fallback: string, opts?: Record<string, unknown>) => string

const COPY: Record<SkillMutationAction, { key: string; fallback: string }> = {
  install: {
    key: 'teamShare.skillInstalledRefreshFailed',
    fallback:
      'Skill installed, but this machine failed to refresh. New sessions may temporarily use a stale cache.',
  },
  uninstall: {
    key: 'teamShare.skillUninstalledRefreshFailed',
    fallback: 'Skill uninstalled, but this machine failed to refresh. New sessions may temporarily use a stale cache.',
  },
  'delete-personal': {
    key: 'teamShare.skillDeletedRefreshFailed',
    fallback: 'Skill deleted, but this machine failed to refresh.',
  },
  'delete-team': {
    key: 'teamShare.skillDeleteTeamRefreshFailed',
    fallback: 'Skill removed from the team, but this machine failed to refresh.',
  },
  restore: {
    key: 'teamShare.skillRestoredRefreshFailed',
    fallback: 'Skill restored, but this machine failed to refresh.',
  },
  revert: {
    key: 'teamShare.skillRevertedRefreshFailed',
    fallback: 'Version restored, but this machine failed to refresh. New sessions may temporarily use a stale cache.',
  },
  discard: {
    key: 'teamShare.skillDiscardedRefreshFailed',
    fallback: 'Local changes discarded, but this machine failed to refresh.',
  },
  'keep-archived': {
    key: 'teamShare.skillRestoredRefreshFailed',
    fallback: 'Skill restored, but this machine failed to refresh.',
  },
}

export function toastSkillMutationRefreshFailed(
  t: Translate,
  error: SkillMutationRefreshError,
  retry: () => Promise<void>,
): void {
  const copy = COPY[error.action]
  toast.error(t(copy.key, copy.fallback), {
    action: {
      label: t('teamShare.skillRetryRefresh', 'Retry refresh'),
      onClick: () => {
        void retry()
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
  })
}
