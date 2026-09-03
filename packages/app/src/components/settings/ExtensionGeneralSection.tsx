import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Link2, Plus, Puzzle, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  addDomainToConfig,
  addUrlPatternToConfig,
  readLinkHoverConfig,
  removeDomainFromConfig,
  removeUrlPatternFromConfig,
  writeLinkHoverConfig,
  type LinkHoverConfig,
} from '@/lib/extension/link-hover'
import { clearLinkSessionMapForTeam } from '@/lib/extension/link-session'
import { useCurrentTeamStore } from '@/stores/current-team'
import { SettingCard, SectionHeader } from './shared'

export const ExtensionGeneralSection = React.memo(function ExtensionGeneralSection() {
  const { t } = useTranslation()
  const [config, setConfig] = React.useState<LinkHoverConfig>({ domains: [], urlPatterns: [] })
  const [draft, setDraft] = React.useState('')
  const [patternDraft, setPatternDraft] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [clearingMap, setClearingMap] = React.useState(false)
  const [confirmClearMap, setConfirmClearMap] = React.useState(false)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await readLinkHoverConfig()
      if (!cancelled) {
        setConfig(next)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persist = React.useCallback(
    async (next: LinkHoverConfig) => {
      setSaving(true)
      try {
        await writeLinkHoverConfig(next)
        setConfig(next)
      } catch (e) {
        console.error('[extension-settings] save link hover config failed', e)
        toast.error(t('settings.extension.linkHover.saveError', 'Could not save domain settings'))
      } finally {
        setSaving(false)
      }
    },
    [t],
  )

  const handleAddDomain = React.useCallback(() => {
    const result = addDomainToConfig(config, draft)
    if (!result.ok) {
      if (result.error === 'duplicate') {
        toast.error(t('settings.extension.linkHover.duplicate', 'Domain already in the list'))
      } else {
        toast.error(t('settings.extension.linkHover.invalid', 'Enter a valid domain, e.g. example.com'))
      }
      return
    }
    setDraft('')
    void persist(result.config)
  }, [config, draft, persist, t])

  const handleRemoveDomain = React.useCallback(
    (domain: string) => {
      void persist(removeDomainFromConfig(config, domain))
    },
    [config, persist],
  )

  const handleAddUrlPattern = React.useCallback(() => {
    const result = addUrlPatternToConfig(config, patternDraft)
    if (!result.ok) {
      if (result.error === 'duplicate') {
        toast.error(
          t('settings.extension.linkHover.patternDuplicate', 'Pattern already in the list'),
        )
      } else {
        toast.error(
          t(
            'settings.extension.linkHover.patternInvalid',
            'Enter a URL pattern, e.g. */example/*',
          ),
        )
      }
      return
    }
    setPatternDraft('')
    void persist(result.config)
  }, [config, patternDraft, persist, t])

  const handleRemoveUrlPattern = React.useCallback(
    (pattern: string) => {
      void persist(removeUrlPatternFromConfig(config, pattern))
    },
    [config, persist],
  )

  const handleClearLinkSessionMap = React.useCallback(async () => {
    if (!teamId) {
      toast.error(t('settings.extension.linkSessionMap.noTeam', 'Select a team first'))
      return
    }
    setClearingMap(true)
    try {
      await clearLinkSessionMapForTeam(teamId)
    } catch (e) {
      console.error('[extension-settings] clear link session map failed', e)
      toast.error(t('settings.extension.linkSessionMap.clearError', 'Could not clear link mappings'))
    } finally {
      setClearingMap(false)
    }
  }, [teamId, t])

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Puzzle}
        title={t('settings.extension.general.title', 'General')}
        description={t(
          'settings.extension.general.description',
          'Extension settings for the browser side panel.',
        )}
      />

      <SettingCard>
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-[10px] border border-border-soft bg-panel p-2.5">
            <Link2 className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-[13px] font-semibold text-foreground">
              {t('settings.extension.linkHover.title', 'Page quick-open button')}
            </h4>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              {t(
                'settings.extension.linkHover.description',
                'On allowlisted sites, hovering a matching link shows a TeamClu button to open the side panel with that link.',
              )}
            </p>
            <p className="mt-2 text-[12px] text-faint">
              {t(
                'settings.extension.linkHover.hint',
                'example.com also matches www.example.com and all subdomains. Nothing is shown until you add at least one domain.',
              )}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddDomain()
              }
            }}
            placeholder={t('settings.extension.linkHover.placeholder', 'example.com')}
            className="h-9 font-mono text-[13px]"
            disabled={loading || saving}
          />
          <Button
            type="button"
            size="sm"
            className="h-9 shrink-0 gap-1.5 px-3"
            onClick={handleAddDomain}
            disabled={loading || saving || !draft.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.extension.linkHover.add', 'Add')}
          </Button>
        </div>

        <div className="mt-4">
          {loading ? (
            <p className="text-[12px] text-muted-foreground">
              {t('common.loading', 'Loading…')}
            </p>
          ) : config.domains.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-[12.5px] text-muted-foreground">
              {t(
                'settings.extension.linkHover.empty',
                'No domains configured — the quick-open button stays hidden on every site.',
              )}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {config.domains.map((domain) => (
                <li key={domain}>
                  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-panel py-1 pl-2.5 pr-1 font-mono text-[12px] text-ink-2">
                    {domain}
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
                      onClick={() => handleRemoveDomain(domain)}
                      disabled={saving}
                      aria-label={t('settings.extension.linkHover.remove', 'Remove {{domain}}', {
                        domain,
                      })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-6 border-t border-border-soft pt-4">
          <h5 className="text-[12.5px] font-semibold text-foreground">
            {t('settings.extension.linkHover.patternsTitle', 'Link URL patterns')}
          </h5>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {t(
              'settings.extension.linkHover.patternsDescription',
              'Optional. Use * as a wildcard anywhere in the URL. Empty list = show the button on every http(s) link on allowlisted sites.',
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={patternDraft}
              onChange={(e) => setPatternDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddUrlPattern()
                }
              }}
              placeholder={t(
                'settings.extension.linkHover.patternPlaceholder',
                '*/example/*',
              )}
              className="h-9 font-mono text-[13px]"
              disabled={loading || saving}
            />
            <Button
              type="button"
              size="sm"
              className="h-9 shrink-0 gap-1.5 px-3"
              onClick={handleAddUrlPattern}
              disabled={loading || saving || !patternDraft.trim()}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('settings.extension.linkHover.addPattern', 'Add')}
            </Button>
          </div>
          <div className="mt-3">
            {loading ? null : config.urlPatterns.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-[12px] text-muted-foreground">
                {t(
                  'settings.extension.linkHover.patternsEmpty',
                  'No patterns — every clickable http(s) link on allowlisted sites shows the button.',
                )}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {config.urlPatterns.map((pattern) => (
                  <li key={pattern}>
                    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-panel py-1 pl-2.5 pr-1 font-mono text-[12px] text-ink-2">
                      <span className="min-w-0 truncate">{pattern}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
                        onClick={() => handleRemoveUrlPattern(pattern)}
                        disabled={saving}
                        aria-label={t(
                          'settings.extension.linkHover.removePattern',
                          'Remove {{pattern}}',
                          { pattern },
                        )}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SettingCard>

      <SettingCard>
        <div className="mb-4">
          <h4 className="text-[13px] font-semibold text-foreground">
            {t('settings.extension.linkSessionMap.title', 'Link-to-session mappings')}
          </h4>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {t(
              'settings.extension.linkSessionMap.description',
              'Clear saved associations between allowlisted page links and chat sessions for the current team.',
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => setConfirmClearMap(true)}
          disabled={clearingMap || !teamId}
        >
          {t('settings.extension.linkSessionMap.clear', 'Clear current team mappings')}
        </Button>
      </SettingCard>

      <AlertDialog open={confirmClearMap} onOpenChange={setConfirmClearMap}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.extension.linkSessionMap.confirmTitle', 'Clear link mappings?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.extension.linkSessionMap.confirmDescription',
                'This removes all saved link-to-session associations for the current team. You cannot undo this.',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                setConfirmClearMap(false)
                void handleClearLinkSessionMap()
              }}
            >
              {t('settings.extension.linkSessionMap.confirmAction', 'Clear mappings')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
