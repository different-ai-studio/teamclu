import { useTranslation } from 'react-i18next'
import { Terminal, Sparkles } from 'lucide-react'

import { appDisplayName } from '@/lib/config/build-config'
import { useAppVersion } from '@/lib/config/version'
import { useOnboardingStore, type OnboardingRole } from '@/stores/onboarding'
import { cn } from '@/lib/utils'

function RoleCard({
  icon,
  title,
  audience,
  recommended,
  caption,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  /** Who this option is for. Stated outright — the titles alone read as two
   *  equally valid moods rather than a recommendation for anybody. */
  audience: string
  recommended?: boolean
  caption: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-1 flex-col items-start gap-2.5 rounded-[16px] border border-border bg-paper p-5 text-left transition-colors hover:bg-selected/45"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-panel text-ink-2 transition-colors group-hover:bg-coral group-hover:text-coral-foreground">
        {icon}
      </span>
      <span className="text-[14px] font-semibold text-foreground">{title}</span>
      <span
        className={cn(
          'rounded-[6px] px-2 py-0.5 text-[11.5px] font-medium',
          recommended ? 'bg-coral-soft text-coral' : 'bg-panel text-muted-foreground',
        )}
      >
        {audience}
      </span>
      <span className="text-[12.5px] leading-5 text-muted-foreground">{caption}</span>
    </button>
  )
}

/**
 * First screen of first-run setup (#881): pick how much of the setup you want
 * to drive. Everything after this branches on the answer — which runtimes are
 * offered, and whether git is checked.
 */
export function RoleStep({ onDone }: { onDone: (role: OnboardingRole) => void }) {
  const { t } = useTranslation()
  const appVersion = useAppVersion()
  const setRole = useOnboardingStore((s) => s.setRole)

  const choose = (role: OnboardingRole) => {
    setRole(role)
    onDone(role)
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8" data-tauri-drag-region>
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col">
        <div className="flex flex-1 flex-col justify-center">
          <div className="mb-7 text-center">
            <img
              src="/logo.png"
              alt={`${appDisplayName} logo`}
              className="mx-auto mb-4 h-16 w-16 object-contain"
            />
            <h1 className="text-[22px] font-semibold text-foreground">
              {t('onboarding.role.title', 'How would you like to set things up?')}
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-muted-foreground">
              {t('onboarding.role.subtitle', 'You can change any of this later in Settings.')}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <RoleCard
              icon={<Sparkles className="h-5 w-5" />}
              title={t('onboarding.role.guidedTitle', 'Just get me started')}
              audience={t('onboarding.role.guidedAudience', 'Recommended if this is new to you')}
              recommended
              caption={t(
                'onboarding.role.guidedCaption',
                "We take the recommended setup and install what's needed for you. Nothing to choose, nothing to install by hand.",
              )}
              onClick={() => choose('guided')}
            />
            <RoleCard
              icon={<Terminal className="h-5 w-5" />}
              title={t('onboarding.role.developerTitle', "I'll set it up myself")}
              audience={t('onboarding.role.developerAudience', 'For developers')}
              caption={t(
                'onboarding.role.developerCaption',
                'Choose the agent runtime yourself and review everything before it installs. Pick this if a terminal is familiar ground.',
              )}
              onClick={() => choose('developer')}
            />
          </div>
        </div>

        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
      </div>
    </div>
  )
}
