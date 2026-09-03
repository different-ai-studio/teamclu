import { Check } from 'lucide-react'

import { changeLanguage, getCurrentLanguage, availableLanguages } from '@/lib/i18n'
import { useAppVersion } from '@/lib/version'
import { cn } from '@/lib/utils'

/**
 * Each language named in its own script, never as an ISO code. Somebody looking
 * for a language they can read recognizes "中文", not "ZH".
 */
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  'zh-CN': '中文',
}

/**
 * Very first screen of first-run setup (#881).
 *
 * It exists alone, with nothing to compete against, because it is the only
 * question whose answer decides whether the user can read the rest of the flow.
 * As a control tucked into a corner of the setup screen it kept getting missed.
 *
 * The prompt is deliberately bilingual: this is the one screen that cannot
 * assume the reader understands the language it is currently rendered in.
 * Everything after it can, because this screen has settled the matter.
 */
export function LanguageStep({ onDone }: { onDone: () => void }) {
  const appVersion = useAppVersion()
  const current = getCurrentLanguage()

  const choose = (lang: string) => {
    void changeLanguage(lang)
    onDone()
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8" data-tauri-drag-region>
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col">
        <div className="flex flex-1 flex-col justify-center">
          <div className="mb-8 text-center">
            <img src="/logo.png" alt="" className="mx-auto mb-5 h-16 w-16 object-contain" />
            {/* Both languages, both plain: no i18n lookup can be trusted to be
                readable until the user has answered this. */}
            <h1 className="text-[22px] font-semibold leading-tight text-foreground">选择语言</h1>
            <p className="mt-1.5 text-[15px] text-muted-foreground">Choose your language</p>
          </div>

          <div className="flex flex-col gap-3">
            {availableLanguages.map((lang) => {
              const isCurrent = lang === current
              return (
                <button
                  key={lang}
                  type="button"
                  onClick={() => choose(lang)}
                  aria-current={isCurrent}
                  className={cn(
                    'flex items-center justify-between rounded-[16px] border bg-paper px-5 py-4 text-left transition-colors',
                    isCurrent
                      ? 'border-ink-2/35 hover:bg-selected/45'
                      : 'border-border hover:bg-selected/45',
                  )}
                >
                  <span className="text-[17px] font-medium text-foreground">
                    {LANGUAGE_LABELS[lang] ?? lang}
                  </span>
                  {/* The system-derived default arrives pre-marked, so the common
                      case is a confirmation rather than a decision. */}
                  {isCurrent && <Check className="h-[18px] w-[18px] shrink-0 text-coral" />}
                </button>
              )
            })}
          </div>
        </div>

        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
      </div>
    </div>
  )
}
