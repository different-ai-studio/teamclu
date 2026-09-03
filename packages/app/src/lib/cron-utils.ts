/**
 * Cron utility functions: datetime helpers and delivery channel registry.
 * Extracted from CronSection.tsx for reuse across cron components.
 */

import {
  type CronSchedule,
  type CronPayload,
  type CronDelivery,
  type CronJob,
  type ScheduleKind,
  type DeliveryChannel,
  type CronPermissionMode,
} from '@/stores/cron'
import { useChannelsStore } from '@/stores/channels-store'
// ==================== Datetime Helpers ====================

/**
 * Convert an ISO 8601 UTC string to a local "YYYY-MM-DDTHH:mm" string
 * suitable for `<input type="datetime-local">`.
 */
export function isoToLocalDatetime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    // Build local date string: YYYY-MM-DDTHH:mm
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day}T${hours}:${minutes}`
  } catch {
    return ''
  }
}

/**
 * Convert a local "YYYY-MM-DDTHH:mm" string from `<input type="datetime-local">`
 * to an ISO 8601 UTC string for storage.
 */
export function localDatetimeToIso(localStr: string): string {
  if (!localStr) return ''
  // new Date() parses "YYYY-MM-DDTHH:mm" as local time
  const d = new Date(localStr)
  if (isNaN(d.getTime())) return ''
  return d.toISOString()
}

// ==================== Delivery Channel Registry ====================

interface DeliveryFieldDef {
  key: string
  label: string
  placeholder: string
  hint: string
  type?: 'text' | 'email'
  required?: boolean
}

interface DeliveryModeDef {
  value: string
  label: string
}

type ChannelsStoreState = ReturnType<typeof useChannelsStore.getState>

interface DeliveryChannelRegistryEntry {
  id: DeliveryChannel
  name: string
  getEnabled: (store: ChannelsStoreState) => boolean
  getConnected: (store: ChannelsStoreState) => boolean
  modes?: DeliveryModeDef[]
  fields: DeliveryFieldDef[] | Record<string, DeliveryFieldDef[]>
  buildTarget: (mode: string, values: Record<string, string>) => string
  parseTarget: (to: string) => { mode: string; values: Record<string, string> }
  getTargetDisplay?: (to: string) => string
}

export const DELIVERY_CHANNEL_REGISTRY: DeliveryChannelRegistryEntry[] = [
  {
    id: 'discord',
    name: 'Discord',
    getEnabled: (s) => !!s.discord?.enabled,
    getConnected: (s) => s.gatewayStatus.status === 'connected',
    modes: [
      { value: 'dm', label: 'Direct Message (DM)' },
      { value: 'channel', label: 'Channel' },
    ],
    fields: {
      dm: [
        {
          key: 'userId',
          label: 'User ID',
          placeholder: 'e.g., 123456789012345678',
          hint: 'The Discord user ID to send DM to. Right-click a user in Discord and select "Copy User ID" (requires Developer Mode).',
          required: true,
        },
      ],
      channel: [
        {
          key: 'channelId',
          label: 'Channel ID',
          placeholder: 'e.g., 123456789012345678',
          hint: 'The Discord channel ID to send messages to. Right-click a channel and select "Copy Channel ID" (requires Developer Mode).',
          required: true,
        },
      ],
    },
    buildTarget: (mode, values) =>
      mode === 'dm' ? `dm:${values.userId}` : `channel:${values.channelId}`,
    parseTarget: (to): { mode: string; values: Record<string, string> } => {
      if (to.startsWith('channel:')) {
        return { mode: 'channel', values: { channelId: to.slice('channel:'.length) } }
      }
      return { mode: 'dm', values: { userId: to.startsWith('dm:') ? to.slice('dm:'.length) : to } }
    },
    getTargetDisplay: (to) => {
      if (to.startsWith('dm:')) return `DM @${to.slice(3)}`
      if (to.startsWith('channel:')) return `#${to.slice(8)}`
      return to
    },
  },
  {
    id: 'feishu',
    name: 'Feishu',
    getEnabled: (s) => !!s.feishu?.enabled,
    getConnected: (s) => s.feishuGatewayStatus.status === 'connected',
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        placeholder: 'e.g., oc_xxxxx',
        hint: 'The Feishu chat/group ID to send messages to.',
        required: true,
      },
    ],
    buildTarget: (_mode, values) => values.chatId,
    parseTarget: (to) => ({ mode: '', values: { chatId: to } }),
  },
  {
    id: 'email',
    name: 'Email',
    getEnabled: (s) => !!s.email?.enabled,
    getConnected: (s) => s.emailGatewayStatus.status === 'connected',
    fields: [
      {
        key: 'emailAddress',
        label: 'Email Address',
        placeholder: 'e.g., user@example.com',
        hint: 'The email address to receive notification.',
        type: 'email',
        required: true,
      },
    ],
    buildTarget: (_mode, values) => values.emailAddress,
    parseTarget: (to) => ({ mode: '', values: { emailAddress: to } }),
  },
  {
    id: 'kook',
    name: 'KOOK',
    getEnabled: (s) => !!s.kook?.enabled,
    getConnected: (s) => s.kookGatewayStatus?.status === 'connected',
    modes: [
      { value: 'dm', label: 'Direct Message (DM)' },
      { value: 'channel', label: 'Channel' },
    ],
    fields: {
      dm: [
        {
          key: 'userId',
          label: 'User ID',
          placeholder: 'e.g., 123456',
          hint: 'The KOOK user ID to send DM to. You can find this in KOOK user profile.',
          required: true,
        },
      ],
      channel: [
        {
          key: 'channelId',
          label: 'Channel ID',
          placeholder: 'e.g., 456789',
          hint: 'The KOOK channel ID to send messages to.',
          required: true,
        },
      ],
    },
    buildTarget: (mode, values) =>
      mode === 'dm' ? `dm:${values.userId}` : `channel:${values.channelId}`,
    parseTarget: (to): { mode: string; values: Record<string, string> } => {
      if (to.startsWith('channel:')) {
        return { mode: 'channel', values: { channelId: to.slice('channel:'.length) } }
      }
      return { mode: 'dm', values: { userId: to.startsWith('dm:') ? to.slice('dm:'.length) : to } }
    },
    getTargetDisplay: (to) => {
      if (to.startsWith('dm:')) return `DM @${to.slice(3)}`
      if (to.startsWith('channel:')) return `#${to.slice(8)}`
      return to
    },
  },
  {
    id: 'wechat',
    name: 'WeChat',
    getEnabled: (s) => !!s.wechat?.enabled,
    getConnected: (s) => s.wechatGatewayStatus?.status === 'connected',
    fields: [
      {
        key: 'userId',
        label: 'User ID',
        placeholder: 'e.g., xxx@im.wechat',
        hint: 'WeChat user ID (from_user_id). Visible in gateway logs after the user sends a message. The gateway must be running and the user must have sent at least one message for delivery to work.',
        required: true,
      },
    ],
    buildTarget: (_mode, values) => values.userId,
    parseTarget: (to) => ({ mode: '', values: { userId: to } }),
  },
  {
    id: 'wecom',
    name: 'WeCom',
    getEnabled: (s) => !!s.wecom?.enabled,
    getConnected: (s) => s.wecomGatewayStatus?.status === 'connected',
    modes: [
      { value: 'single', label: 'Single Chat (DM)' },
      { value: 'group', label: 'Group Chat' },
    ],
    fields: {
      single: [
        {
          key: 'userId',
          label: 'User ID',
          placeholder: 'e.g., zhangsan',
          hint: 'The WeCom userid for single chat. Visible in gateway logs when the user sends a message. The user must have messaged the bot at least once.',
          required: true,
        },
      ],
      group: [
        {
          key: 'chatId',
          label: 'Chat ID',
          placeholder: 'e.g., wrkSFfCgAAxxxxxx',
          hint: 'The WeCom group chatid. Visible in gateway logs when a group message is received.',
          required: true,
        },
      ],
    },
    buildTarget: (mode, values) =>
      mode === 'group' ? `group:${values.chatId}` : `single:${values.userId}`,
    parseTarget: (to): { mode: string; values: Record<string, string> } => {
      if (to.startsWith('group:')) {
        return { mode: 'group', values: { chatId: to.slice('group:'.length) } }
      }
      const userId = to.startsWith('single:') ? to.slice('single:'.length) : to
      return { mode: 'single', values: { userId } }
    },
    getTargetDisplay: (to) => {
      if (to.startsWith('group:')) return `Group ${to.slice(6)}`
      if (to.startsWith('single:')) return `DM @${to.slice(7)}`
      return `DM @${to}`
    },
  },
  {
    id: 'seatalk',
    name: 'SeaTalk',
    getEnabled: (s) => !!s.seatalk?.enabled,
    getConnected: (s) => s.seatalkGatewayStatus?.status === 'connected',
    modes: [
      { value: 'single', label: 'Direct Message (DM)' },
      { value: 'group', label: 'Group Chat' },
    ],
    fields: {
      single: [
        {
          key: 'employeeCode',
          label: 'Employee Code',
          placeholder: 'e.g., E001234',
          hint: 'SeaTalk employee_code for the DM recipient. Visible in gateway logs when the user messages the bot.',
          required: true,
        },
      ],
      group: [
        {
          key: 'groupId',
          label: 'Group ID',
          placeholder: 'e.g., group id from SeaTalk',
          hint: 'SeaTalk group_id. Visible in gateway logs when the bot is @mentioned in that group.',
          required: true,
        },
      ],
    },
    buildTarget: (mode, values) =>
      mode === 'group' ? `group:${values.groupId}` : `single:${values.employeeCode}`,
    parseTarget: (to): { mode: string; values: Record<string, string> } => {
      if (to.startsWith('group:')) {
        return { mode: 'group', values: { groupId: to.slice('group:'.length) } }
      }
      const employeeCode = to.startsWith('single:') ? to.slice('single:'.length) : to
      return { mode: 'single', values: { employeeCode } }
    },
    getTargetDisplay: (to) => {
      if (to.startsWith('group:')) return `Group ${to.slice(6)}`
      if (to.startsWith('single:')) return `DM @${to.slice(7)}`
      return `DM @${to}`
    },
  },
]

export function getRegistryEntry(channelId: DeliveryChannel): DeliveryChannelRegistryEntry | undefined {
  return DELIVERY_CHANNEL_REGISTRY.find((e) => e.id === channelId)
}

// ==================== Job Form State ====================

export interface JobFormState {
  name: string
  enabled: boolean
  scheduleKind: ScheduleKind
  at: string
  everyValue: number
  everyUnit: 'minutes' | 'hours' | 'days'
  cronExpr: string
  cronTz: string
  message: string
  model: string
  /** Backend the model belongs to: "opencode" | "claude" | "codex" | "" (auto). */
  backend: string
  deliveryEnabled: boolean
  deliveryChannel: DeliveryChannel
  deliveryTargetMode: string
  deliveryTargetValues: Record<string, string>
  deliveryBestEffort: boolean
  deleteAfterRun: boolean
  runImmediately: boolean
  permissionMode: CronPermissionMode
}

/** Cron runs unattended, so approvals default to off — see `CronPayload.permissionMode`. */
const DEFAULT_CRON_PERMISSION_MODE: CronPermissionMode = 'full_access'

export const defaultFormState: JobFormState = {
  name: '',
  enabled: true,
  scheduleKind: 'every',
  at: '',
  everyValue: 30,
  everyUnit: 'minutes',
  cronExpr: '',
  cronTz: '',
  message: '',
  model: '',
  backend: '',
  deliveryEnabled: false,
  deliveryChannel: 'discord',
  deliveryTargetMode: 'dm',
  deliveryTargetValues: {},
  deliveryBestEffort: true,
  deleteAfterRun: false,
  runImmediately: true,
  permissionMode: DEFAULT_CRON_PERMISSION_MODE,
}

export function jobToFormState(job: CronJob): JobFormState {
  // Parse interval from everyMs
  let everyValue = 30
  let everyUnit: 'minutes' | 'hours' | 'days' = 'minutes'
  if (job.schedule.everyMs) {
    const ms = job.schedule.everyMs
    if (ms >= 86400000) {
      everyValue = Math.round(ms / 86400000)
      everyUnit = 'days'
    } else if (ms >= 3600000) {
      everyValue = Math.round(ms / 3600000)
      everyUnit = 'hours'
    } else {
      everyValue = Math.round(ms / 60000)
      everyUnit = 'minutes'
    }
  }

  // Parse delivery target using registry
  const deliveryTo = job.delivery?.to || ''
  const deliveryChannel = job.delivery?.channel || 'discord'
  const entry = getRegistryEntry(deliveryChannel)
  const parsed = entry?.parseTarget(deliveryTo) ?? { mode: '', values: {} }

  return {
    name: job.name,
    enabled: job.enabled,
    scheduleKind: job.schedule.kind,
    at: job.schedule.at || '',
    everyValue,
    everyUnit,
    cronExpr: job.schedule.expr || '',
    cronTz: job.schedule.tz || '',
    message: job.payload.message,
    model: job.payload.model || '',
    backend: job.payload.backend || '',
    deliveryEnabled: !!job.delivery,
    deliveryChannel,
    deliveryTargetMode: parsed.mode,
    deliveryTargetValues: parsed.values,
    deliveryBestEffort: job.delivery?.bestEffort ?? true,
    deleteAfterRun: job.deleteAfterRun,
    runImmediately: false,
    // Absent on jobs saved before the field existed — those ran with approvals
    // auto-granted, so full access is the faithful reading, not a silent change.
    permissionMode: job.payload.permissionMode ?? DEFAULT_CRON_PERMISSION_MODE,
  }
}

export function formStateToSchedule(form: JobFormState): CronSchedule {
  switch (form.scheduleKind) {
    case 'at':
      if (!form.at) {
        throw new Error('Date & Time is required for one-time schedule')
      }
      return { kind: 'at', at: form.at }
    case 'every': {
      let ms = form.everyValue
      switch (form.everyUnit) {
        case 'minutes':
          ms *= 60000
          break
        case 'hours':
          ms *= 3600000
          break
        case 'days':
          ms *= 86400000
          break
      }
      return { kind: 'every', everyMs: ms }
    }
    case 'cron':
      return {
        kind: 'cron',
        expr: form.cronExpr,
        tz: form.cronTz || undefined,
      }
    default:
      return { kind: 'every', everyMs: 1800000 }
  }
}

export function formStateToPayload(form: JobFormState): CronPayload {
  return {
    message: form.message,
    model: form.model || undefined,
    // Only pin a backend when a model is chosen; "use default model" leaves both
    // empty so the daemon falls back to its default_agent_type ("auto").
    backend: form.model && form.backend ? form.backend : undefined,
    permissionMode: form.permissionMode,
  }
}

export function formStateToDelivery(form: JobFormState): CronDelivery | undefined {
  if (!form.deliveryEnabled) return undefined

  const entry = getRegistryEntry(form.deliveryChannel)
  const to = entry
    ? entry.buildTarget(form.deliveryTargetMode, form.deliveryTargetValues)
    : ''

  return {
    mode: 'announce',
    channel: form.deliveryChannel,
    to,
    bestEffort: form.deliveryBestEffort,
  }
}

/** Get the delivery target display string for UI */
export function getDeliveryTargetDisplay(delivery: CronDelivery): string {
  const entry = getRegistryEntry(delivery.channel)
  if (entry?.getTargetDisplay) {
    return entry.getTargetDisplay(delivery.to)
  }
  return delivery.to
}
