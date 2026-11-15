import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import { Languages } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { changeLanguage, isLocaleLocked } from '@/lib/i18n'
import { LANGUAGE_OPTIONS, getPreferredLanguage, normalizeSupportedLanguage, persistLanguage } from '@/lib/locale'
import { SettingCard } from './shared'

/**
 * Display-language picker shared by desktop Settings → General and the
 * extension's General section. Persists through `@/lib/i18n` so the catalogue
 * is loaded before the switch; the native locale hook is best-effort.
 */
export function LanguageSettingCard() {
  const { t } = useTranslation()
  const [language, setLanguage] = React.useState(() => getPreferredLanguage())

  React.useEffect(() => {
    const handleLanguageChange = () => {
      setLanguage(i18next.language)
    }

    i18next.on('languageChanged', handleLanguageChange)
    return () => {
      i18next.off('languageChanged', handleLanguageChange)
    }
  }, [])

  const handleLanguageChange = React.useCallback((value: string) => {
    const normalizedValue = normalizeSupportedLanguage(value)
    setLanguage(normalizedValue)
    // Through `@/lib/i18n`, not `i18next` directly: catalogues are fetched on
    // demand (PERF-15), and only this wrapper loads the target one before
    // switching. Calling i18next straight through swaps to a locale with no
    // strings and paints raw keys.
    void changeLanguage(normalizedValue)
    persistLanguage(normalizedValue)
    void invoke('set_config_locale', { locale: normalizedValue }).catch(() => {
      // Settings should still update locally if the native config is unavailable.
    })
  }, [])

  if (isLocaleLocked) return null

  return (
    <SettingCard>
      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t('settings.general.language', 'Language')}
        </label>
        <p className="text-xs text-muted-foreground">
          {t('settings.general.languageDesc', 'Choose the app display language')}
        </p>
        <Select value={language} onValueChange={handleLanguageChange}>
          <SelectTrigger className="h-11" data-testid="language-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.value === 'en' ? '🇺🇸 ' : '🇨🇳 '}
                {t(option.labelKey, option.fallback)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SettingCard>
  )
}
