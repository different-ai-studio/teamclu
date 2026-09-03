import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  Plug,
  Loader2,
  Key,
  Shield,
  Plus,
  CircleDot,
  RefreshCw,
  Link,
  Trash2,
  ChevronRight,
  ChevronDown,
  Zap,
  Settings,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react'
import { useProviderStore } from '@/stores/provider'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamModeStore } from '@/stores/team-mode'
import { TEAM_SHARED_PROVIDER_ID } from '@/lib/agent/team-provider'
import { TeamProviderCard } from './llm/TeamProviderCard'
import {
  catalogModelsForProvider,
  groupCatalogModelsByProvider,
} from '@/lib/agent/group-catalog-models-by-provider'
import {
  ensureLocalDaemonCatalog,
  useLocalDaemonCatalogStore,
} from '@/stores/local-daemon-catalog-store'
import { MAINSTREAM_PROVIDER_IDS } from '@/lib/agent/mainstream-providers'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader } from './shared'


type OpenAICompatibleModel = {
  id: string
  name?: string
}

function openAICompatibleModelsUrl(baseURL: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}/models`
}

async function fetchOpenAICompatibleModels(baseURL: string, apiKey: string): Promise<OpenAICompatibleModel[]> {
  const response = await fetch(openAICompatibleModelsUrl(baseURL), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`OpenAI-compatible validation failed (${response.status})`)
  }
  const payload = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> }
  return (payload.data ?? [])
    .map((model) => ({
      id: typeof model.id === 'string' ? model.id.trim() : '',
      name: typeof model.name === 'string' ? model.name.trim() : undefined,
    }))
    .filter((model) => model.id.length > 0)
}

export const OpenCodeLLMSection = React.memo(function OpenCodeLLMSection() {
  const { t } = useTranslation()
  const teamModelConfig = useTeamModeStore((s) => s.teamModelConfig)
  const devUnlocked = useTeamModeStore((s) => s.devUnlocked)
  const providers = useProviderStore((s) => s.providers)
  const providersLoading = useProviderStore((s) => s.providersLoading)
  const refreshProviders = useProviderStore((s) => s.refreshProviders)
  const refreshConfiguredProviders = useProviderStore((s) => s.refreshConfiguredProviders)
  const authMethods = useProviderStore((s) => s.authMethods)
  const refreshAuthMethods = useProviderStore((s) => s.refreshAuthMethods)
  const connectProvider = useProviderStore((s) => s.connectProvider)
  const connectProviderOAuth = useProviderStore((s) => s.connectProviderOAuth)
  const completeOAuthCallback = useProviderStore((s) => s.completeOAuthCallback)
  const customProviderIds = useProviderStore((s) => s.customProviderIds)
  const refreshCustomProviderIds = useProviderStore((s) => s.refreshCustomProviderIds)
  const addCustomProvider = useProviderStore((s) => s.addCustomProvider)
  const updateCustomProvider = useProviderStore((s) => s.updateCustomProvider)
  const getCustomProvider = useProviderStore((s) => s.getCustomProvider)
  const removeCustomProvider = useProviderStore((s) => s.removeCustomProvider)
  const disconnectProvider = useProviderStore((s) => s.disconnectProvider)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const catalogEntry = useLocalDaemonCatalogStore((s) =>
    workspacePath ? s.byWorkspacePath[workspacePath] : undefined,
  )
  const catalogModels = React.useMemo(
    () => catalogEntry?.models ?? [],
    [catalogEntry?.models],
  )
  const catalogIsLoading =
    !catalogEntry || catalogEntry.status === 'pending' || catalogEntry.fetchedAt === 0
  const catalogLoadFailed =
    catalogEntry?.status === 'error' || catalogEntry?.status === 'unknown'

  // Dialog state for connecting a provider
  const [connectDialogOpen, setConnectDialogOpen] = React.useState(false)
  const [connectingProviderId, setConnectingProviderId] = React.useState<string>('')
  const [connectingProviderName, setConnectingProviderName] = React.useState<string>('')
  const [apiKeyInput, setApiKeyInput] = React.useState('')
  const [isConnecting, setIsConnecting] = React.useState(false)

  // Custom provider dialog state
  const [customDialogOpen, setCustomDialogOpen] = React.useState(false)
  const [editingProviderId, setEditingProviderId] = React.useState<string | null>(null)
  const [customName, setCustomName] = React.useState('')
  const [customBaseURL, setCustomBaseURL] = React.useState('')
  const [customApiKey, setCustomApiKey] = React.useState('')
  const [customModels, setCustomModels] = React.useState<Array<{
    modelId: string
    modelName: string
    contextLimit: string
    outputLimit: string
  }>>([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
  const [isAddingCustom, setIsAddingCustom] = React.useState(false)
  const [isValidatingCustom, setIsValidatingCustom] = React.useState(false)
  const [customValidationMessage, setCustomValidationMessage] = React.useState<string | null>(null)

  // Delete confirmation state
  const [deletingProviderId, setDeletingProviderId] = React.useState<string | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)

  // OAuth flow state
  const [oauthPending, setOAuthPending] = React.useState(false)
  const [oauthInstructions, setOAuthInstructions] = React.useState('')
  const [oauthUrl, setOAuthUrl] = React.useState('')
  const [oauthMethodType, setOAuthMethodType] = React.useState<'auto' | 'code' | null>(null)
  const [oauthCodeInput, setOAuthCodeInput] = React.useState('')
  const [oauthCodeCopied, setOAuthCodeCopied] = React.useState(false)

  // Disconnect confirmation state
  const [disconnectingProviderId, setDisconnectingProviderId] = React.useState<string | null>(null)
  const [disconnectingProviderName, setDisconnectingProviderName] = React.useState<string>('')
  const [isDisconnecting, setIsDisconnecting] = React.useState(false)

  // Detail view for connected provider
  const [selectedProviderId, setSelectedProviderId] = React.useState<string | null>(null)

  // Collapsible other providers
  const [showAllProviders, setShowAllProviders] = React.useState(false)

  const { visibleProviders, hiddenCount } = React.useMemo(() => {
    const connected: typeof providers = []
    const mainstream: typeof providers = []
    const others: typeof providers = []
    const mergedProviders = [...providers]
    const knownProviderIds = new Set(providers.map((provider) => provider.id))

    for (const group of groupCatalogModelsByProvider(catalogModels)) {
      if (
        group.providerId !== TEAM_SHARED_PROVIDER_ID &&
        !knownProviderIds.has(group.providerId)
      ) {
        mergedProviders.push({
          id: group.providerId,
          name: group.providerId,
          configured: false,
        })
      }
    }

    for (const p of mergedProviders) {
      // The team-shared provider is rendered as its own pinned card below.
      if (p.id === TEAM_SHARED_PROVIDER_ID) continue
      if (p.configured) {
        connected.push(p)
      } else if (
        customProviderIds.includes(p.id) ||
        MAINSTREAM_PROVIDER_IDS.has(p.id.toLowerCase()) ||
        catalogModelsForProvider(catalogModels, p.id).length > 0
      ) {
        mainstream.push(p)
      } else {
        others.push(p)
      }
    }

    return {
      visibleProviders: showAllProviders
        ? [...connected, ...mainstream, ...others]
        : [...connected, ...mainstream],
      hiddenCount: others.length,
    }
  }, [providers, showAllProviders, customProviderIds, catalogModels])

  const refreshAllProviders = React.useCallback(async () => {
    await Promise.all([refreshProviders(), refreshConfiguredProviders(), refreshAuthMethods()])
  }, [refreshProviders, refreshConfiguredProviders, refreshAuthMethods])

  const refreshModelCatalog = React.useCallback(() => {
    if (!workspacePath) return
    ensureLocalDaemonCatalog(workspacePath, 'opencode', { force: true })
  }, [workspacePath])

  React.useEffect(() => {
    void refreshAllProviders()
    if (workspacePath) {
      refreshCustomProviderIds(workspacePath)
      ensureLocalDaemonCatalog(workspacePath, 'opencode')
    }
  }, [refreshAllProviders, refreshCustomProviderIds, workspacePath])

  const getProviderOAuthMethodIndex = (providerId: string): number => {
    const methods = authMethods[providerId] || []
    return methods.findIndex((m) => m.type === 'oauth')
  }

  const handleConnectClick = (providerId: string, providerName: string) => {
    setConnectingProviderId(providerId)
    setConnectingProviderName(providerName)
    setApiKeyInput('')
    setOAuthPending(false)
    setOAuthInstructions('')
    setOAuthUrl('')
    setOAuthMethodType(null)
    setOAuthCodeInput('')
    setConnectDialogOpen(true)
    void refreshAuthMethods()
  }

  const handleConnectSubmit = async () => {
    if (!apiKeyInput.trim()) return
    setIsConnecting(true)
    const success = await connectProvider(connectingProviderId, apiKeyInput.trim())
    if (success) {
      setConnectDialogOpen(false)
      setApiKeyInput('')
      await refreshAllProviders()
      refreshModelCatalog()
    }
    setIsConnecting(false)
  }

  const handleOAuthLogin = async () => {
    const methodIndex = getProviderOAuthMethodIndex(connectingProviderId)
    if (methodIndex === -1) return
    setIsConnecting(true)
    const result = await connectProviderOAuth(connectingProviderId, methodIndex)
    if (result.status !== 'pending') {
      setIsConnecting(false)
      return
    }
    // Open browser and show instructions
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(result.url)
    setOAuthUrl(result.url)
    setOAuthInstructions(result.instructions)
    setOAuthMethodType(result.methodType)
    setOAuthCodeInput('')
    setOAuthPending(true)
    setIsConnecting(false)
    if (result.methodType === 'auto') {
      // For Device Flow ("auto"), sidecar polls internally — kick off callback in background
      completeOAuthCallback(connectingProviderId, methodIndex).then((success) => {
        if (success) {
          setConnectDialogOpen(false)
          setOAuthPending(false)
          setOAuthMethodType(null)
          setOAuthCodeInput('')
          void refreshAllProviders()
          refreshModelCatalog()
        }
      })
    }
  }

  const handleOAuthCodeSubmit = async () => {
    const code = oauthCodeInput.trim()
    if (!code) return
    const methodIndex = getProviderOAuthMethodIndex(connectingProviderId)
    if (methodIndex === -1) return
    setIsConnecting(true)
    try {
      const success = await completeOAuthCallback(connectingProviderId, methodIndex, code)
      if (success) {
        setConnectDialogOpen(false)
        setOAuthPending(false)
        setOAuthMethodType(null)
        setOAuthCodeInput('')
        await refreshAllProviders()
        refreshModelCatalog()
      }
    } finally {
      setIsConnecting(false)
    }
  }

  const handleCopyOAuthCode = async () => {
    // Extract code from instructions (e.g. "Enter code: XXXX-YYYY")
    const match = oauthInstructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)
    if (match) {
      await navigator.clipboard.writeText(match[0])
      setOAuthCodeCopied(true)
      setTimeout(() => setOAuthCodeCopied(false), 2000)
    }
  }

  const handleProviderClick = (providerId: string, configured: boolean, providerName: string) => {
    if (canExpandProvider(providerId, configured)) {
      setSelectedProviderId(selectedProviderId === providerId ? null : providerId)
      return
    }
    if (configured) return
    handleConnectClick(providerId, providerName)
  }

  const getProviderModels = (providerId: string) =>
    catalogModelsForProvider(catalogModels, providerId)

  const canExpandProvider = (providerId: string, _configured: boolean) =>
    catalogModelsForProvider(catalogModels, providerId).length > 0

  const [isRefreshing, setIsRefreshing] = React.useState(false)

  const handleRefreshProviders = async () => {
    setIsRefreshing(true)
    await refreshAllProviders()
    if (workspacePath) {
      await refreshCustomProviderIds(workspacePath)
    }
    refreshModelCatalog()
    setIsRefreshing(false)
  }

  const handleOpenAddCustomDialog = () => {
    setEditingProviderId(null)
    setCustomName('')
    setCustomBaseURL('')
    setCustomApiKey('')
    setCustomModels([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
    setCustomValidationMessage(null)
    setCustomDialogOpen(true)
  }

  const handleOpenEditCustomDialog = async (providerId: string) => {
    if (!workspacePath) return
    setEditingProviderId(providerId)

    const config = await getCustomProvider(workspacePath, providerId)
    if (config) {
      setCustomName(config.name)
      setCustomBaseURL(config.baseURL)
      setCustomApiKey('')
      setCustomModels(config.models.map(m => ({
        modelId: m.modelId,
        modelName: m.modelName || '',
        contextLimit: m.limit?.context?.toString() || '',
        outputLimit: m.limit?.output?.toString() || '',
      })))
      setCustomValidationMessage(null)
      setCustomDialogOpen(true)
    }
  }

  const handleUseOpenAIDefaults = () => {
    setCustomName((name) => name.trim() || 'OpenAI')
    setCustomBaseURL('https://api.openai.com/v1')
    setCustomValidationMessage(null)
  }

  const handleValidateCustomProvider = async () => {
    const baseURL = customBaseURL.trim()
    const apiKey = customApiKey.trim()
    if (!baseURL || !apiKey) return

    setIsValidatingCustom(true)
    setCustomValidationMessage(null)
    try {
      const models = await fetchOpenAICompatibleModels(baseURL, apiKey)
      if (models.length > 0) {
        setCustomModels(models.map((model) => ({
          modelId: model.id,
          modelName: model.name || '',
          contextLimit: '',
          outputLimit: '',
        })))
        setCustomValidationMessage(t('settings.llm.openaiValidationSuccess', {
          count: models.length,
          defaultValue: `Validated and loaded ${models.length} models.`,
        }))
      } else {
        setCustomValidationMessage(t('settings.llm.openaiValidationNoModels', 'Validated, but no models were returned.'))
      }
    } catch (error) {
      setCustomValidationMessage(error instanceof Error ? error.message : t('settings.llm.openaiValidationFailed', 'Validation failed.'))
    } finally {
      setIsValidatingCustom(false)
    }
  }

  const handleAddCustomSubmit = async () => {
    if (!customName.trim() || !customBaseURL.trim() || !workspacePath) return

    // Validate at least one model with valid modelId
    const validModels = customModels.filter(m => m.modelId.trim())
    if (validModels.length === 0) return

    const providerConfig = {
      name: customName.trim(),
      baseURL: customBaseURL.trim(),
      models: validModels.map(m => {
        const contextLimit = m.contextLimit.trim() ? parseInt(m.contextLimit.trim()) : undefined
        const outputLimit = m.outputLimit.trim() ? parseInt(m.outputLimit.trim()) : undefined

        // Only include limit if at least one valid number is provided
        const limit = (contextLimit && !isNaN(contextLimit)) || (outputLimit && !isNaN(outputLimit))
          ? {
              context: contextLimit && !isNaN(contextLimit) ? contextLimit : undefined,
              output: outputLimit && !isNaN(outputLimit) ? outputLimit : undefined,
            }
          : undefined

        return {
          modelId: m.modelId.trim(),
          modelName: m.modelName.trim() || undefined,
          limit,
        }
      }),
    }

    setIsAddingCustom(true)
    try {
      if (editingProviderId) {
        // Update existing provider
        const success = await updateCustomProvider(workspacePath, editingProviderId, providerConfig)
        if (success) {
          setCustomDialogOpen(false)
          setEditingProviderId(null)
          setCustomName('')
          setCustomBaseURL('')
          setCustomApiKey('')
          setCustomModels([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
          await refreshAllProviders()
          await refreshCustomProviderIds(workspacePath)
          refreshModelCatalog()
        }
      } else {
        // Add new provider
        if (!customApiKey.trim()) return
        const providerId = await addCustomProvider(workspacePath, providerConfig, customApiKey.trim())

        if (providerId) {
          setCustomDialogOpen(false)
          setCustomName('')
          setCustomBaseURL('')
          setCustomApiKey('')
          setCustomModels([{ modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
          await refreshAllProviders()
          await refreshCustomProviderIds(workspacePath)
          refreshModelCatalog()
        }
      }
    } finally {
      setIsAddingCustom(false)
    }
  }

  const handleAddModelRow = () => {
    setCustomModels([...customModels, { modelId: '', modelName: '', contextLimit: '', outputLimit: '' }])
  }

  const handleRemoveModelRow = (index: number) => {
    if (customModels.length > 1) {
      setCustomModels(customModels.filter((_, i) => i !== index))
    }
  }

  const handleModelChange = (index: number, field: 'modelId' | 'modelName' | 'contextLimit' | 'outputLimit', value: string) => {
    const newModels = [...customModels]
    newModels[index] = { ...newModels[index], [field]: value }
    setCustomModels(newModels)
  }

  const handleDeleteCustomProvider = async (providerId: string) => {
    if (!workspacePath) return
    setIsDeleting(true)
    try {
      const success = await removeCustomProvider(workspacePath, providerId)
      if (success) {
        setDeletingProviderId(null)
        await refreshAllProviders()
        await refreshCustomProviderIds(workspacePath)
        refreshModelCatalog()
      }
    } finally {
      setIsDeleting(false)
    }
  }

  const isCustomProvider = (providerId: string) => customProviderIds.includes(providerId)

  const handleDisconnectProvider = async (providerId: string) => {
    setIsDisconnecting(true)
    try {
      const success = await disconnectProvider(providerId)
      if (success) {
        setDisconnectingProviderId(null)
        setDisconnectingProviderName('')
        refreshModelCatalog()
      }
    } finally {
      setIsDisconnecting(false)
    }
  }

  const teamModelOptions = useTeamModeStore((s) => s.teamModelOptions)
  const switchTeamModel = useTeamModeStore((s) => s.switchTeamModel)

  if (teamModelConfig && !devUnlocked) {
    const hasMultipleModels = teamModelOptions.length > 1
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Brain}
          title={t('settings.llm.title', 'LLM Model')}
          description={t('settings.llm.description', 'Manage AI providers and connect them to enable model selection')}
          iconColor="text-purple-500"
        />
        <SettingCard>
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">
              <Shield className="h-4.5 w-4.5" />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-medium">{t('settings.llm.managedByTeam', 'Managed by team')}</p>
              {hasMultipleModels ? (
                <div className="flex items-center gap-1.5 mt-2">
                  {teamModelOptions.map((option) => {
                    const isActive = teamModelConfig?.model === option.id
                    return (
                      <button
                        key={option.id}
                        onClick={() => workspacePath && switchTeamModel(option.id, workspacePath)}
                        className={cn(
                          'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                          isActive
                            ? 'bg-violet-600 text-white'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80',
                        )}
                      >
                        {option.name}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('settings.llm.managedByTeamDesc', 'Model configuration is managed by team admin, no personal configuration needed.')}
                </p>
              )}
              {teamModelConfig && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {teamModelConfig.modelName} · {teamModelConfig.baseUrl}
                </p>
              )}
            </div>
          </div>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionHeader
          icon={Brain}
          title={t('settings.llm.title', 'LLM Model')}
          description={t('settings.llm.description', 'Manage AI providers and connect them to enable model selection')}
          iconColor="text-purple-500"
        />
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenAddCustomDialog}
            className="h-8 gap-1.5 text-xs text-muted-foreground"
            title={t('settings.llm.addCustomTooltip', 'Add custom OpenAI-compatible provider')}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.llm.addCustom', 'Add Custom')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshProviders}
            disabled={isRefreshing}
            className="h-8 gap-1.5 text-xs text-muted-foreground"
            title={t('settings.llm.refreshTooltip', 'Refresh providers from OpenCode')}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            {isRefreshing ? t('settings.llm.refreshing', 'Refreshing...') : t('settings.llm.refresh', 'Refresh')}
          </Button>
        </div>
      </div>


      {/* The team gateway is pinned above the connectable providers. */}
      <TeamProviderCard />

      {/* Loading State */}
      {providersLoading && providers.length === 0 && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}


      {/* Provider List */}
      {!providersLoading || providers.length > 0 ? (
        <div className="space-y-1.5">
          {visibleProviders.map((p) => {
            const isConnected = p.configured
            const isExpanded = selectedProviderId === p.id
            const models = getProviderModels(p.id)
            const canExpand = canExpandProvider(p.id, isConnected)

            return (
              <SettingCard key={p.id} className={cn(
                "!p-3 cursor-pointer hover:border-primary/30 transition-all",
                isExpanded && "border-primary/40"
              )}>
                <div
                  className="flex items-center justify-between"
                  onClick={() => handleProviderClick(p.id, isConnected, p.name)}
                >
                  <div className="flex items-center gap-2.5">
                    <div className={cn(
                      "h-7 w-7 rounded-md flex items-center justify-center text-[12px] font-medium",
                      isConnected
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-[13px] font-medium">{p.name}</p>
                        {isCustomProvider(p.id) && (
                          <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-900/30 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-400">
                            {t('settings.llm.custom', 'Custom')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {catalogIsLoading
                          ? t('settings.llm.modelsLoading', 'Loading models...')
                          : catalogLoadFailed
                            ? t('settings.llm.modelsUnavailable', 'Models could not be loaded')
                            : models.length > 0 || isConnected
                              ? t('settings.llm.modelsAvailable', { count: models.length, defaultValue: `${models.length} model${models.length !== 1 ? 's' : ''} available` })
                              : t('settings.llm.notConnected', 'Not connected')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isConnected ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          title={t('settings.llm.updateApiKeyTooltip', 'Update API key')}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleConnectClick(p.id, p.name)
                          }}
                        >
                          <Key className="h-3.5 w-3.5" />
                        </Button>
                        {isCustomProvider(p.id) && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              title={t('settings.llm.editCustomTooltip', 'Edit custom provider')}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleOpenEditCustomDialog(p.id)
                              }}
                            >
                              <Settings className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              title={t('settings.llm.removeCustomTooltip', 'Remove custom provider')}
                              onClick={(e) => {
                                e.stopPropagation()
                                setDeletingProviderId(p.id)
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-orange-600"
                          title={t('settings.llm.disconnectTooltip', 'Disconnect provider')}
                          onClick={(e) => {
                            e.stopPropagation()
                            setDisconnectingProviderId(p.id)
                            setDisconnectingProviderName(p.name)
                          }}
                        >
                          <Plug className="h-3.5 w-3.5" />
                        </Button>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                          <CircleDot className="h-3 w-3" />
                          {t('settings.llm.connected', 'Connected')}
                        </span>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleConnectClick(p.id, p.name)
                        }}
                      >
                        <Key className="h-3 w-3 mr-1" />
                        {t('settings.llm.connect', 'Connect')}
                      </Button>
                    )}
                    {canExpand && (
                      <ChevronRight className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90"
                      )} />
                    )}
                  </div>
                </div>

                {/* Expanded model list for catalog-backed provider */}
                {canExpand && isExpanded && models.length > 0 && (
                  <div className="mt-4 pt-4 border-t space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground mb-2">{t('settings.llm.availableModels', 'Available Models')}</p>
                    {models.map((m) => (
                      <div key={m.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 text-[13px]">
                        <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{m.name}</span>
                        <span className="text-xs text-muted-foreground ml-auto">{m.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </SettingCard>
            )
          })}

          {hiddenCount > 0 && (
            <button
              className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted/50"
              onClick={() => setShowAllProviders(!showAllProviders)}
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAllProviders && "rotate-180")} />
              {showAllProviders
                ? t('settings.llm.showLess', 'Show Less')
                : t('settings.llm.showMore', { count: hiddenCount, defaultValue: `Show ${hiddenCount} more providers` })}
            </button>
          )}

          {visibleProviders.length === 0 && !providersLoading && (
            <SettingCard>
              <div className="text-center py-6 text-muted-foreground">
                <Plug className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-[13px]">{t('settings.llm.noProviders', 'No providers available')}</p>
                <p className="text-xs mt-1">{t('settings.llm.noProvidersHint', 'Make sure OpenCode is running and connected.')}</p>
              </div>
            </SettingCard>
          )}
        </div>
      ) : null}

      {/* Connect Provider Dialog */}
      <Dialog open={connectDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setOAuthPending(false)
          setOAuthInstructions('')
          setOAuthUrl('')
          setOAuthMethodType(null)
          setOAuthCodeInput('')
        }
        setConnectDialogOpen(open)
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.connectTitle', { provider: connectingProviderName, defaultValue: `Connect ${connectingProviderName}` })}</DialogTitle>
            <DialogDescription>
              {oauthPending
                ? t('settings.llm.oauthWaiting', 'Browser opened. Complete authorization and return here.')
                : getProviderOAuthMethodIndex(connectingProviderId) !== -1
                  ? t('settings.llm.connectDescriptionOAuth', 'Connect via your browser subscription or enter an API key.')
                  : t('settings.llm.connectDescription', 'Enter your API key to connect this provider. Your key is stored locally.')}
            </DialogDescription>
          </DialogHeader>

          {oauthPending ? (
            /* OAuth Device Flow — waiting for user to complete in browser */
            <div className="space-y-4 py-2">
              <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <p className="text-[13px] font-medium">{oauthInstructions}</p>
                {/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(oauthInstructions) && (
                  <Button variant="outline" size="sm" className="gap-2" onClick={handleCopyOAuthCode}>
                    {oauthCodeCopied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {oauthCodeCopied ? t('settings.llm.copied', 'Copied!') : t('settings.llm.copyCode', 'Copy code')}
                  </Button>
                )}
              </div>
              {oauthMethodType === 'code' ? (
                <div className="space-y-2">
                  <label className="text-[13px] font-medium">{t('settings.llm.authorizationCode', 'Authorization code')}</label>
                  <Input
                    value={oauthCodeInput}
                    onChange={(e) => setOAuthCodeInput(e.target.value)}
                    placeholder={t('settings.llm.authorizationCodePlaceholder', 'Paste authorization code')}
                    className="h-10"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && oauthCodeInput.trim()) {
                        handleOAuthCodeSubmit()
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  {t('settings.llm.oauthPolling', 'Waiting for authorization...')}
                </div>
              )}
              <Button variant="outline" size="sm" className="gap-2 w-full" onClick={async () => {
                const { open } = await import('@tauri-apps/plugin-shell')
                open(oauthUrl)
              }}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t('settings.llm.reopenBrowser', 'Re-open browser')}
              </Button>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {/* OAuth login button — shown when provider supports OAuth */}
              {getProviderOAuthMethodIndex(connectingProviderId) !== -1 && (
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    className="w-full h-11 gap-2 justify-center"
                    onClick={handleOAuthLogin}
                    disabled={isConnecting}
                  >
                    {isConnecting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    {t('settings.llm.loginWithBrowser', 'Login with browser')}
                  </Button>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">{t('settings.llm.or', 'or')}</span>
                    </div>
                  </div>
                </div>
              )}
              {/* API Key input */}
              <div className="space-y-2">
                <label className="text-[13px] font-medium flex items-center gap-2">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  {t('settings.llm.apiKey', 'API Key')}
                </label>
                <div className="relative">
                  <Input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={t('settings.llm.apiKeyPlaceholder', 'sk-...')}
                    className="h-11 pr-10"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && apiKeyInput.trim()) {
                        handleConnectSubmit()
                      }
                    }}
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" />
                  {t('settings.llm.apiKeyPrivacy', 'Your API key is stored locally and never sent to our servers.')}
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOAuthPending(false)
                setOAuthMethodType(null)
                setOAuthCodeInput('')
                setConnectDialogOpen(false)
              }}
              disabled={isConnecting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            {oauthPending && oauthMethodType === 'code' && (
              <Button
                onClick={handleOAuthCodeSubmit}
                disabled={isConnecting || !oauthCodeInput.trim()}
                className="gap-2"
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.llm.connecting', 'Connecting...')}
                  </>
                ) : (
                  <>
                    <Link className="h-4 w-4" />
                    {t('settings.llm.completeAuthorization', 'Complete authorization')}
                  </>
                )}
              </Button>
            )}
            {!oauthPending && (
              <Button
                onClick={handleConnectSubmit}
                disabled={isConnecting || !apiKeyInput.trim()}
                className="gap-2"
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.llm.connecting', 'Connecting...')}
                  </>
                ) : (
                  <>
                    <Link className="h-4 w-4" />
                    {t('settings.llm.connect', 'Connect')}
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Custom Provider Dialog */}
      <Dialog open={customDialogOpen} onOpenChange={(open) => {
        setCustomDialogOpen(open)
        if (!open) setEditingProviderId(null)
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingProviderId
                ? t('settings.llm.editCustomProvider', 'Edit Custom Provider')
                : t('settings.llm.addCustomProvider', 'Add Custom Provider')}
            </DialogTitle>
            <DialogDescription>
              {editingProviderId
                ? t('settings.llm.editCustomProviderDesc', 'Update your custom OpenAI-compatible provider configuration.')
                : t('settings.llm.addCustomProviderDesc', 'Add an OpenAI-compatible provider with your own base URL and API key.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 overflow-y-auto flex-1">
            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.llm.providerName', 'Provider Name')}</label>
              <Input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t('settings.llm.providerNamePlaceholder', 'e.g. My OpenAI Proxy')}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[13px] font-medium">{t('settings.llm.baseUrl', 'Base URL')}</label>
                {!editingProviderId && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={handleUseOpenAIDefaults}
                    className="text-muted-foreground"
                  >
                    {t('settings.llm.useOpenAIDefaults', 'Use OpenAI defaults')}
                  </Button>
                )}
              </div>
              <Input
                value={customBaseURL}
                onChange={(e) => setCustomBaseURL(e.target.value)}
                placeholder={t('settings.llm.baseUrlPlaceholder', 'e.g. https://api.openai.com/v1')}
                className="h-10"
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.llm.baseUrlHint', 'The API endpoint URL (OpenAI-compatible format)')}
              </p>
            </div>
            {!editingProviderId && (
              <div className="space-y-2">
                <label className="text-[13px] font-medium flex items-center gap-2">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  {t('settings.llm.apiKey', 'API Key')}
                </label>
                <div className="relative">
                  <Input
                    type="password"
                    value={customApiKey}
                    onChange={(e) => setCustomApiKey(e.target.value)}
                    placeholder={t('settings.llm.apiKeyPlaceholder', 'sk-...')}
                    className="h-10 pr-10"
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleValidateCustomProvider}
                  disabled={isValidatingCustom || !customBaseURL.trim() || !customApiKey.trim()}
                  className="w-full gap-2"
                >
                  {isValidatingCustom ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {t('settings.llm.validateOpenAIModels', 'Validate & fetch models')}
                </Button>
                {customValidationMessage && (
                  <p className="text-xs text-muted-foreground">{customValidationMessage}</p>
                )}
              </div>
            )}

            {/* Models Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium">{t('settings.llm.models', 'Models')}</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleAddModelRow}
                  className="h-7 gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('settings.llm.addModel', 'Add Model')}
                </Button>
              </div>

              <div className="space-y-3">
                {customModels.map((model, index) => (
                  <div key={index} className="border rounded-lg p-3 space-y-3 bg-muted/20">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('settings.llm.modelNumber', { number: index + 1, defaultValue: `Model ${index + 1}` })}
                      </span>
                      {customModels.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveModelRow(index)}
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium">{t('settings.llm.modelId', 'Model ID')}</label>
                      <Input
                        value={model.modelId}
                        onChange={(e) => handleModelChange(index, 'modelId', e.target.value)}
                        placeholder={t('settings.llm.modelIdPlaceholder', 'e.g. gpt-4o')}
                        className="h-8"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium">{t('settings.llm.modelName', 'Model Name')} ({t('common.optional', 'Optional')})</label>
                      <Input
                        value={model.modelName}
                        onChange={(e) => handleModelChange(index, 'modelName', e.target.value)}
                        placeholder={t('settings.llm.modelNamePlaceholder', 'e.g. GPT-4o')}
                        className="h-8"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <label className="text-xs font-medium">{t('settings.llm.contextLimit', 'Context Limit')} ({t('common.optional', 'Optional')})</label>
                        <Input
                          type="number"
                          value={model.contextLimit}
                          onChange={(e) => handleModelChange(index, 'contextLimit', e.target.value)}
                          placeholder={t('settings.llm.contextLimitPlaceholder', 'e.g. 128000')}
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium">{t('settings.llm.outputLimit', 'Output Limit')} ({t('common.optional', 'Optional')})</label>
                        <Input
                          type="number"
                          value={model.outputLimit}
                          onChange={(e) => handleModelChange(index, 'outputLimit', e.target.value)}
                          placeholder={t('settings.llm.outputLimitPlaceholder', 'e.g. 4096')}
                          className="h-8"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCustomDialogOpen(false)
                setEditingProviderId(null)
              }}
              disabled={isAddingCustom}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleAddCustomSubmit}
              disabled={
                isAddingCustom ||
                !customName.trim() ||
                !customBaseURL.trim() ||
                (!editingProviderId && !customApiKey.trim()) ||
                !customModels.some(m => m.modelId.trim())
              }
              className="gap-2"
            >
              {isAddingCustom ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {editingProviderId
                    ? t('settings.llm.updating', 'Updating...')
                    : t('settings.llm.adding', 'Adding...')}
                </>
              ) : (
                <>
                  {editingProviderId ? <Settings className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {editingProviderId
                    ? t('settings.llm.updateProvider', 'Update Provider')
                    : t('settings.llm.addProvider', 'Add Provider')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Custom Provider Confirmation Dialog */}
      <Dialog open={!!deletingProviderId} onOpenChange={(open) => { if (!open) setDeletingProviderId(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.removeCustomProvider', 'Remove Custom Provider')}</DialogTitle>
            <DialogDescription>
              {t('settings.llm.removeCustomProviderDesc', 'This will remove the provider configuration from opencode.json. This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingProviderId(null)}
              disabled={isDeleting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingProviderId && handleDeleteCustomProvider(deletingProviderId)}
              disabled={isDeleting}
              className="gap-2"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.llm.removing', 'Removing...')}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  {t('settings.llm.remove', 'Remove')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Provider Confirmation Dialog */}
      <Dialog open={!!disconnectingProviderId} onOpenChange={(open) => { if (!open) { setDisconnectingProviderId(null); setDisconnectingProviderName('') } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('settings.llm.disconnectProvider', 'Disconnect Provider')}</DialogTitle>
            <DialogDescription>
              {t('settings.llm.disconnectProviderDesc', { provider: disconnectingProviderName, defaultValue: `This will disconnect ${disconnectingProviderName} and remove its authentication credentials. You can reconnect later by entering a new API key.` })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setDisconnectingProviderId(null); setDisconnectingProviderName('') }}
              disabled={isDisconnecting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectingProviderId && handleDisconnectProvider(disconnectingProviderId)}
              disabled={isDisconnecting}
              className="gap-2"
            >
              {isDisconnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.llm.disconnecting', 'Disconnecting...')}
                </>
              ) : (
                <>
                  <Plug className="h-4 w-4" />
                  {t('settings.llm.disconnect', 'Disconnect')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
