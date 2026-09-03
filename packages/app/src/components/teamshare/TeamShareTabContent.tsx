import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plug, Box } from 'lucide-react'
import { toast } from 'sonner'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { type TeamShareTarget } from '@/lib/tabs/teamshare-target'
import { lazyNamed } from '@/lib/lazy-component'
import { PaneLoading } from '@/components/ui/pane-loading'
import { SkillFileEditor } from './SkillFileEditor'
import { MarketplacePane } from './MarketplacePane'
import { McpDetail, McpEditForm } from './McpDetail'
import { EnvDetail, EnvCreateForm } from './EnvDetail'

// SkillDetail is the largest team-share view by a wide margin (2,200+ lines with
// eight private components); it loads when a skill is first opened.
const SkillDetail = lazyNamed(() => import('./SkillDetail'), 'SkillDetail')

/**
 * Compose surface for a new item. Authoring happens here, never in the list.
 *
 * Closing it clears the direct detail pane.
 */
function CreatePane({ section }: { section: 'mcp' | 'env' }) {
  const { t } = useTranslation()
  // The env form owns the scope toggle, but the title sits in this header — so
  // it reports back rather than the header guessing.
  const [envScope, setEnvScope] = React.useState<'team' | 'personal'>('team')
  const createMcp = useTeamShareBrowserStore((s) => s.createMcp)
  const createPersonalMcp = useTeamShareBrowserStore((s) => s.createPersonalMcp)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)
  const clearDetail = useTeamShareBrowserStore((s) => s.clearDetail)
  const hasTeam = useCurrentTeamStore((s) => Boolean(s.team?.id))
  // Where a new MCP server lands: the team catalog (share it) or just this
  // machine's workspace config. Without a team only the local option exists.
  const [mcpScope, setMcpScope] = React.useState<'team' | 'personal'>(hasTeam ? 'team' : 'personal')
  const Icon = section === 'mcp' ? Plug : Box

  const close = React.useCallback(() => {
    clearDetail()
  }, [clearDetail])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {section === 'mcp'
              ? t('teamShare.mcpDetail.server', 'MCP Server')
              : t('teamShare.env', 'Team Env')}
          </div>
          <div className="truncate text-[15px] font-bold text-foreground">
            {section === 'mcp'
              ? t('teamShare.mcpAdd', 'Add MCP server')
              : envScope === 'team'
                ? t('teamShare.envAddTeam', 'Add team env key')
                : t('teamShare.envAddPersonal', 'Add personal env key')}
          </div>
        </div>
      </div>

      <div className="px-6 py-5">
        {section === 'mcp' ? (
          <div className="space-y-4">
            {hasTeam && (
              <div className="flex items-center gap-1 rounded-lg bg-muted p-1 text-[12.5px]" role="radiogroup">
                {(['team', 'personal'] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    role="radio"
                    aria-checked={mcpScope === scope}
                    onClick={() => setMcpScope(scope)}
                    className={
                      mcpScope === scope
                        ? 'flex-1 rounded-md bg-background px-3 py-1.5 font-semibold text-foreground shadow-sm'
                        : 'flex-1 rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground'
                    }
                  >
                    {scope === 'team'
                      ? t('teamShare.mcpScopeTeam', 'Team catalog')
                      : t('teamShare.mcpScopePersonal', 'This machine only')}
                  </button>
                ))}
              </div>
            )}
            <McpEditForm
              submitLabel={
                mcpScope === 'team'
                  ? t('teamShare.mcpAddSubmit', 'Add to team')
                  : t('teamShare.mcpAddPersonalSubmit', 'Add to this machine')
              }
              onCancel={close}
              onSubmit={async (input) => {
                if (mcpScope === 'team') {
                  await createMcp(input)
                  toast.success(
                    t(
                      'teamShare.mcpAdded',
                      'Added to the team catalog. Install it to run it on this machine.',
                    ),
                  )
                } else {
                  await createPersonalMcp(input)
                  toast.success(t('teamShare.mcpAddedPersonal', 'Added to this workspace.'))
                }
                close()
              }}
            />
          </div>
        ) : (
          <EnvCreateForm
            onScopeChange={setEnvScope}
            onCancel={close}
            onDone={() => {
              close()
              void loadCounts()
            }}
          />
        )}
      </div>
    </div>
  )
}

/** Renders the one team-share view currently selected beside the sidebar list. */
export function TeamShareDetailContent({ target }: { target: TeamShareTarget }) {
  switch (target.kind) {
    case 'skill':
      return (
        <React.Suspense fallback={<PaneLoading />}>
          <SkillDetail key={target.id} slug={target.id} />
        </React.Suspense>
      )
    case 'skill-file':
      return (
        <SkillFileEditor
          key={`${target.id}:${target.rel}`}
          slug={target.id}
          rel={target.rel}
        />
      )
    case 'marketplace':
      return <MarketplacePane key="marketplace" />
    case 'marketplace-item':
      return <MarketplacePane key={target.slug} slug={target.slug} />
    case 'mcp':
      return <McpDetail key={target.name} name={target.name} />
    case 'env':
      return <EnvDetail key={target.keyId} keyId={target.keyId} />
    case 'create':
      return <CreatePane key={target.section} section={target.section} />
  }
}

/** Backward-compatible renderer for native tabs saved by older builds. */
export const TeamShareTabContent = TeamShareDetailContent
