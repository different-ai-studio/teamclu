import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { SettingsSection } from '@/stores/ui'

/**
 * Settings sections are code-split, one chunk per section.
 *
 * They are only ever mounted from inside the Settings dialog, which most
 * sessions never open — statically importing all 26 of them dragged the whole
 * subtree (channels, cron, skills, LLM, …) into the startup chunk. `React.lazy`
 * keeps the section list itself cheap and pays for a section only when the user
 * actually navigates to it.
 */
const lazySection = (load: () => Promise<Record<string, unknown>>, name: string) =>
  React.lazy(async () => ({ default: (await load())[name] as React.ComponentType }))

export const SETTINGS_SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  llm: lazySection(() => import('./LLMSectionRouter'), 'LLMSection'),
  teamLlm: lazySection(() => import('./TeamLlmSection'), 'TeamLlmSection'),
  general: lazySection(() => import('./GeneralSection'), 'GeneralSection'),
  prompt: lazySection(() => import('./PromptSection'), 'PromptSection'),
  channels: lazySection(() => import('./ChannelsSection'), 'ChannelsSection'),
  automation: lazySection(() => import('./CronSection'), 'CronSection'),
  daemonGeneral: lazySection(() => import('./DaemonGeneralSection'), 'DaemonGeneralSection'),
  daemonWorkspaces: lazySection(() => import('./DaemonWorkspacesSection'), 'DaemonWorkspacesSection'),
  daemonRuntimes: lazySection(() => import('./DaemonRuntimesSection'), 'DaemonRuntimesSection'),
  envVars: lazySection(() => import('./EnvVarsSection'), 'EnvVarsSection'),
  // Standalone Skills settings page removed — team/personal skills live in the
  // Team Share browser. Keep the registry key so deep links to `skills` land
  // on Role Skills (which still embeds SkillsSection for role attachment).
  skills: lazySection(() => import('./RolesSkillsSection'), 'RolesSkillsSection'),
  roles: lazySection(() => import('./RolesSection'), 'RolesSection'),
  rolesSkills: lazySection(() => import('./RolesSkillsSection'), 'RolesSkillsSection'),
  deps: lazySection(() => import('./DependenciesSection'), 'DependenciesSection'),
  billing: lazySection(() => import('./BillingSection'), 'BillingSection'),
  tokenUsage: lazySection(() => import('./TokenUsageSection'), 'TokenUsageSection'),
  privacy: lazySection(() => import('./PrivacySection'), 'PrivacySection'),
  permissions: lazySection(() => import('./PermissionManagementSection'), 'PermissionManagementSection'),
  leaderboard: lazySection(() => import('./LeaderboardSection'), 'LeaderboardSection'),
  shortcuts: lazySection(() => import('@/components/shortcuts/ShortcutsSection'), 'ShortcutsSection'),
  cache: lazySection(() => import('./CacheSection'), 'CacheSection'),
  diagnostics: lazySection(() => import('./DiagnosticsSection'), 'DiagnosticsSection'),
}

export function SettingsSectionBody({ section }: { section: SettingsSection }) {
  const Component = SETTINGS_SECTION_COMPONENTS[section]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/*
        Radix ScrollArea's Viewport wraps children in an inline-styled
        `display:table; min-width:100%` div, which shrink-to-fits to the
        content's max-content width. Any non-wrapping descendant (e.g. a
        `truncate` URL = white-space:nowrap, or a long path) then forces that
        table wider than the pane, and the outer `overflow-hidden` clips it on
        the right. Force the viewport's inner wrapper to `display:block` so it
        respects the pane width and our `max-w-[960px]` content wraps/truncates
        instead of overflowing. Scoped to this ScrollArea via its data-slot.
      */}
      <ScrollArea className="h-full min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="w-full min-w-0 max-w-[960px] p-8 pr-10">
          <React.Suspense
            fallback={
              <div className="flex h-40 items-center justify-center" data-testid="settings-section-loading">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            {React.createElement(Component)}
          </React.Suspense>
        </div>
      </ScrollArea>
    </div>
  )
}
