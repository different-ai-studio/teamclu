import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { DaemonWorkspace } from '@/lib/daemon/daemon-workspaces'
import type { DeviceModelOption } from '@/lib/agent/device-default-models'
import type { ChannelRuntimeSelection } from './channel-runtime'

const fieldClass =
  'h-9 w-full rounded-[7px] border border-border bg-paper px-3 text-[13px] transition-colors focus:border-foreground/30 focus:outline-none'

export function ChannelRuntimeOptions({
  workspaceId,
  model,
  workspaces,
  models,
  inheritedWorkspaceId,
  inheritedModel,
  onChange,
}: {
  workspaceId?: string
  model?: string
  workspaces: DaemonWorkspace[]
  models: DeviceModelOption[]
  inheritedWorkspaceId: string | null
  inheritedModel: string | null
  onChange: (patch: ChannelRuntimeSelection) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const workspaceValue = workspaceId || inheritedWorkspaceId || ''
  const modelValue = model || inheritedModel || ''
  const workspaceChoices = workspaceOptions(workspaces, workspaceValue)
  const modelChoices = modelOptions(models, modelValue, inheritedModel)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center gap-1.5 py-1 text-left text-[12px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        {t('settings.channels.runtime.advanced', 'Advanced options')}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {t('settings.channels.runtime.workspace', 'Workspace')}
          </label>
          {workspaceChoices.length > 0 ? (
            <select
              value={workspaceValue}
              onChange={(event) => onChange({ workspaceId: event.target.value || undefined })}
              className={fieldClass}
            >
              {!workspaceValue && (
                <option value="">
                  {t('settings.channels.runtime.workspaceUnset', 'Temporary directory')}
                </option>
              )}
              {workspaceChoices.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name || workspace.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={workspaceValue}
              onChange={(event) => onChange({ workspaceId: event.target.value || undefined })}
              placeholder={t('settings.channels.runtime.workspaceUnset', 'Temporary directory')}
              className={fieldClass}
            />
          )}
          <p className="text-[11px] text-muted-foreground">
            {t(
              'settings.channels.runtime.workspaceHint',
              'New sessions on this channel run here. Saving stores the current choice; you can change it later.',
            )}
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {t('settings.channels.runtime.model', 'Model')}
          </label>
          {modelChoices.length > 0 ? (
            <select
              value={modelValue}
              onChange={(event) => onChange({ model: event.target.value || undefined })}
              className={fieldClass}
            >
              {!modelValue && (
                <option value="">
                  {t('settings.channels.runtime.modelPiDefault', 'Pi default model')}
                </option>
              )}
              {modelChoices.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={modelValue}
              onChange={(event) => onChange({ model: event.target.value || undefined })}
              placeholder={
                inheritedModel ||
                t('settings.channels.runtime.modelPiDefault', 'Pi default model')
              }
              className={fieldClass}
            />
          )}
          <p className="text-[11px] text-muted-foreground">
            {t(
              'settings.channels.runtime.modelHint',
              'Prefilled from the gateway model, or pi’s own default when that is unset. A later change applies to new sessions.',
            )}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function workspaceOptions(workspaces: DaemonWorkspace[], selectedId: string): DaemonWorkspace[] {
  if (!selectedId || workspaces.some((workspace) => workspace.id === selectedId)) return workspaces
  return [
    ...workspaces,
    {
      id: selectedId,
      teamId: '',
      agentId: null,
      createdByMemberId: null,
      name: selectedId,
      path: null,
      archived: false,
      createdAt: '',
      updatedAt: '',
    },
  ]
}

function modelOptions(
  models: DeviceModelOption[],
  selectedId: string,
  inheritedModel: string | null,
): { id: string; displayName: string }[] {
  const options = models.map((model) => ({
    id: model.id,
    displayName: model.displayName || model.id,
  }))
  for (const id of [selectedId, inheritedModel ?? '']) {
    if (id && !options.some((option) => option.id === id)) {
      options.unshift({ id, displayName: id })
    }
  }
  return options
}
