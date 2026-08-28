import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Shield,
  Trash2,
  RefreshCw,
  Loader2,
  Terminal,
  FileEdit,
  FileText,
  Check,
  X,
  AlertTriangle,
  Save,
  Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingCard, SectionHeader } from './shared'
import { useEffectiveWorkspacePath } from '@/lib/effective-workspace'
import {
  encodeWorkspaceId,
  getDaemonToolPermissions,
  putDaemonToolPermissions,
  getDaemonAllowlist,
  putDaemonAllowlist,
  type DaemonAllowlistRule,
  type DaemonPermissionMap,
} from '@/lib/daemon-local-client'

type PermissionAction = 'allow' | 'ask' | 'deny'

type PermissionConfig = DaemonPermissionMap

// TeamClu defaults: destructive operations require approval, read-only auto-approved.
// These are written to opencode.json on first launch if no permission section exists.
const PERMISSION_DEFAULTS: PermissionConfig = {
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  codesearch: 'allow',
  todoread: 'allow',
  todowrite: 'allow',
  question: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  edit: 'ask',
  write: 'ask',
  bash: 'ask',
  task: 'allow',
  lsp: 'allow',
  skill: 'allow',
  external_directory: 'ask',
  doom_loop: 'ask',
}

const PERMISSION_LABELS: Record<keyof PermissionConfig, { label: string; desc: string; icon: React.ElementType }> = {
  read: { label: 'Read Files', desc: 'Read file contents', icon: FileText },
  glob: { label: 'Glob', desc: 'File pattern matching', icon: FileText },
  grep: { label: 'Grep', desc: 'Search file contents', icon: FileText },
  list: { label: 'List', desc: 'List directory contents', icon: FileText },
  codesearch: { label: 'Code Search', desc: 'Search across codebase', icon: FileText },
  todoread: { label: 'Read Todos', desc: 'Read todo list', icon: FileText },
  todowrite: { label: 'Write Todos', desc: 'Update todo list', icon: FileEdit },
  question: { label: 'Ask Questions', desc: 'Interactive questions', icon: FileText },
  webfetch: { label: 'Web Fetch', desc: 'Fetch web content', icon: FileText },
  websearch: { label: 'Web Search', desc: 'Search the web', icon: FileText },
  edit: { label: 'Edit Files', desc: 'Modify file contents', icon: FileEdit },
  write: { label: 'Write Files', desc: 'Create/write files', icon: FileEdit },
  bash: { label: 'Bash Commands', desc: 'Execute shell commands', icon: Terminal },
  task: { label: 'Subagents', desc: 'Launch subagents', icon: FileText },
  lsp: { label: 'LSP Queries', desc: 'Language Server Protocol', icon: FileText },
  skill: { label: 'Skills', desc: 'Load skills', icon: FileText },
  external_directory: { label: 'External Dirs', desc: 'Access outside workspace', icon: FileText },
  doom_loop: { label: 'Doom Loop Guard', desc: 'Prevent infinite loops', icon: AlertTriangle },
}

export const PermissionManagementSection = React.memo(function PermissionManagementSection() {
  const { t } = useTranslation()
  const workspacePath = useEffectiveWorkspacePath()

  // Allowlist state (flat list from daemon)
  const [allowlistRules, setAllowlistRules] = React.useState<DaemonAllowlistRule[]>([])
  const [loadingAllowlist, setLoadingAllowlist] = React.useState(false)

  // Permission config state
  const [permissionConfig, setPermissionConfig] = React.useState<PermissionConfig>({})
  const [loadingConfig, setLoadingConfig] = React.useState(false)
  const [savingConfig, setSavingConfig] = React.useState(false)
  const [configModified, setConfigModified] = React.useState(false)

  const workspaceId = React.useMemo(
    () => (workspacePath ? encodeWorkspaceId(workspacePath) : null),
    [workspacePath],
  )

  const loadAllowlist = React.useCallback(async () => {
    if (!workspaceId) return
    setLoadingAllowlist(true)
    try {
      const rules = await getDaemonAllowlist(workspaceId)
      setAllowlistRules(rules ?? [])
    } catch (error) {
      console.error('[PermissionManagement] Failed to load allowlist:', error)
      setAllowlistRules([])
    } finally {
      setLoadingAllowlist(false)
    }
  }, [workspaceId])

  const removeRule = React.useCallback(
    async (index: number) => {
      if (!workspaceId) return
      const updated = allowlistRules.filter((_, i) => i !== index)
      try {
        await putDaemonAllowlist(workspaceId, updated)
        setAllowlistRules(updated)
      } catch (error) {
        console.error('[PermissionManagement] Failed to remove rule:', error)
      }
    },
    [allowlistRules, workspaceId],
  )

  const loadPermissionConfig = React.useCallback(async () => {
    if (!workspaceId) return
    setLoadingConfig(true)
    try {
      const cfg = await getDaemonToolPermissions(workspaceId)
      setPermissionConfig(cfg ?? {})
    } catch (error) {
      console.error('[PermissionManagement] Failed to load permissions:', error)
    } finally {
      setLoadingConfig(false)
    }
  }, [workspaceId])

  const savePermissionConfig = React.useCallback(async () => {
    if (!workspaceId) return
    setSavingConfig(true)
    try {
      await putDaemonToolPermissions(workspaceId, permissionConfig)
      setConfigModified(false)
    } catch (error) {
      console.error('[PermissionManagement] Failed to save permissions:', error)
    } finally {
      setSavingConfig(false)
    }
  }, [workspaceId, permissionConfig])

  const updatePermission = React.useCallback((key: string, value: PermissionAction) => {
    setPermissionConfig((prev) => ({ ...prev, [key]: value }))
    setConfigModified(true)
  }, [])

  React.useEffect(() => {
    loadAllowlist()
    loadPermissionConfig()
  }, [loadAllowlist, loadPermissionConfig])

  if (!workspacePath) {
    return (
      <div>
        <SectionHeader
          icon={Shield}
          title={t('settings.permissions.title', 'Permission Management')}
          description={t('settings.permissions.desc', 'Manage agent permissions and command allowlist')}
          iconColor="text-emerald-500"
        />
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.permissions.noWorkspace', 'No workspace selected. Please select a workspace first.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Shield}
        title={t('settings.permissions.title', 'Permission Management')}
        description={t('settings.permissions.desc', 'Manage agent permissions and command allowlist')}
        iconColor="text-emerald-500"
      />

      {/* Allowlist Section */}
      <SettingCard>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-[13px] font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-amber-500" />
              {t('settings.permissions.allowlist', 'Command Allowlist')}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.permissions.allowlistDesc', 'Commands marked as "Always Allow". Takes effect after agent restart.')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadAllowlist}
            disabled={loadingAllowlist}
          >
            {loadingAllowlist ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>

        {loadingAllowlist ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : allowlistRules.length === 0 ? (
          <div className="text-center py-8 text-[13px] text-muted-foreground">
            {t('settings.permissions.noAllowlist', 'No commands have been allowlisted yet')}
          </div>
        ) : (
          <div className="relative">
            <div className="max-h-[400px] overflow-y-auto space-y-2 pr-2">
              {allowlistRules.map((rule, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30"
                >
                  <Terminal className="h-4 w-4 text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <code className="text-[13px] font-mono">{rule.permission}: {rule.pattern}</code>
                  </div>
                  <Badge
                    variant={rule.decision === 'allow' ? 'default' : 'destructive'}
                    className={cn(
                      'text-xs shrink-0',
                      rule.decision === 'allow' && 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20'
                    )}
                  >
                    {rule.decision}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRule(index)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent pointer-events-none" />
          </div>
        )}

      </SettingCard>

      {/* Permission Config Section */}
      <SettingCard>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-[13px] font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-emerald-500" />
              {t('settings.permissions.config', 'Permission Configuration')}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.permissions.configDesc', 'Configure default permission policies for agent tools')}
            </p>
          </div>
          <div className="flex gap-2">
            {configModified && (
              <Button
                variant="default"
                size="sm"
                onClick={savePermissionConfig}
                disabled={savingConfig}
              >
                {savingConfig ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                {savingConfig
                  ? t('settings.permissions.saving', 'Applying...')
                  : t('settings.permissions.saveAndApply', 'Save & Apply')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={loadPermissionConfig}
              disabled={loadingConfig}
            >
              {loadingConfig ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {loadingConfig ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {(Object.keys(PERMISSION_LABELS) as Array<keyof typeof PERMISSION_LABELS>).map((key) => {
              const { label, desc, icon: Icon } = PERMISSION_LABELS[key]
              const value = (permissionConfig[key] || PERMISSION_DEFAULTS[key] || 'allow') as PermissionAction

              return (
                <div
                  key={key}
                  className="flex items-center gap-4 p-3 rounded-lg border bg-muted/20"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                  </div>
                  <Select
                    value={value}
                    onValueChange={(v) => updatePermission(key as string, v as PermissionAction)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">
                        <div className="flex items-center gap-2">
                          <Check className="h-3 w-3 text-green-500" />
                          {t('settings.permissions.allow', 'Allow')}
                        </div>
                      </SelectItem>
                      <SelectItem value="ask">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                          {t('settings.permissions.ask', 'Ask')}
                        </div>
                      </SelectItem>
                      <SelectItem value="deny">
                        <div className="flex items-center gap-2">
                          <X className="h-3 w-3 text-red-500" />
                          {t('settings.permissions.deny', 'Deny')}
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )
            })}
          </div>
        )}

        <div className="mt-4 pt-4 border-t">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Shield className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
            <div className="text-xs text-blue-600 dark:text-blue-400">
              <p className="font-medium mb-1">
                {t('settings.permissions.configInfo', 'Permission Actions')}
              </p>
              <ul className="space-y-1 list-disc list-inside">
                <li>
                  <strong>Allow</strong>: {t('settings.permissions.allowDesc', 'Auto-approve without prompting')}
                </li>
                <li>
                  <strong>Ask</strong>: {t('settings.permissions.askDesc', 'Prompt for approval each time')}
                </li>
                <li>
                  <strong>Deny</strong>: {t('settings.permissions.denyDesc', 'Block the action')}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </SettingCard>
    </div>
  )
})
