// Channel type definitions and default configs — extracted from channels.ts
import { appDisplayName } from '@/lib/config/build-config'

// Gateway status types
export type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// DM configuration
export interface DmConfig {
  enabled: boolean
  policy: 'open' | 'allowlist'
  allowFrom: string[]
  groupEnabled: boolean
  groupChannels: string[]
}

// Channel rule
export interface ChannelRule {
  allow: boolean
  requireMention?: boolean
  users: string[]
}

// Guild configuration
export interface GuildConfig {
  slug?: string
  channels: Record<string, ChannelRule>
}

// Retry configuration
export interface RetryConfig {
  attempts: number
  minDelayMs: number
  maxDelayMs: number
  jitter: number
}

// Discord configuration
export interface DiscordConfig {
  enabled: boolean
  token: string
  dm: DmConfig
  guilds: Record<string, GuildConfig>
  retry?: RetryConfig
}

// Feishu chat configuration
export interface FeishuChatConfig {
  allow: boolean
  users: string[]
}

// Feishu configuration
export interface FeishuConfig {
  enabled: boolean
  appId: string
  appSecret: string
  chats: Record<string, FeishuChatConfig>
}

// Feishu gateway status
export type FeishuGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Feishu gateway status response
export interface FeishuGatewayStatusResponse {
  status: FeishuGatewayStatus
  errorMessage?: string
  appId?: string
}

// SeaTalk configuration
export interface SeaTalkConfig {
  enabled: boolean
  appId: string
  appSecret: string
  /** `websocket` (default) or `webhook` */
  mode: string
  /** `open` | `allowlist` */
  dmPolicy: string
  allowFrom: string[]
  /** `disabled` | `allowlist` | `open` — default `open` for @bot */
  groupPolicy: string
  groupAllowFrom: string[]
}

export type SeaTalkGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface SeaTalkGatewayStatusResponse {
  status: SeaTalkGatewayStatus
  errorMessage?: string
  appId?: string
}

// Email provider type
export type EmailProvider = 'gmail' | 'custom'

// Email configuration
export interface EmailConfig {
  enabled: boolean
  provider: EmailProvider
  // Gmail OAuth2 fields
  gmailClientId: string
  gmailClientSecret: string
  gmailEmail: string
  gmailAuthorized: boolean
  // Custom IMAP/SMTP fields
  imapServer: string
  imapPort: number
  smtpServer: string
  smtpPort: number
  username: string
  password: string
  // Filter settings
  recipientAlias: string
  allowedSenders: string[]
  labels: string[]
  replyAllNew: boolean
  displayName: string
}

// Email gateway status
export type EmailGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Email gateway status response
export interface EmailGatewayStatusResponse {
  status: EmailGatewayStatus
  errorMessage?: string
  email?: string
}

// KOOK configuration
// KOOK-specific DM configuration
export interface KookDmConfig {
  enabled: boolean
  policy: 'open' | 'allowlist'
  allowFrom: string[]
}

// KOOK-specific channel rule
export interface KookChannelRule {
  enabled: boolean
  requireMention: boolean
  allowedUsers: string[]
}

// KOOK-specific guild configuration
export interface KookGuildConfig {
  enabled: boolean
  slug?: string
  channels: Record<string, KookChannelRule>
}

export interface KookConfig {
  enabled: boolean
  token: string
  dm: KookDmConfig
  guilds: Record<string, KookGuildConfig>
}

// KOOK gateway status
export type KookGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// KOOK gateway status response
export interface KookGatewayStatusResponse {
  status: KookGatewayStatus
  errorMessage?: string
  botUsername?: string
  connectedGuilds: string[]
}

// WeCom types
export interface WeComBot {
  enabled: boolean
  botId: string
  secret: string
  encodingAesKey?: string
  workspaceId?: string
  systemPrompt?: string
  /**
   * The bot's display name in WeCom. Group messages arrive as `@<name> 正文`
   * with the mention only in the text, so this is what lets the gateway strip
   * it back off — without it, a name containing spaces swallows the command.
   */
  botName?: string
  /**
   * MCP api key from WeCom's 「消息」 authorization page. Optional: it is what
   * lets the desktop list the chats this bot is in, which is how a cron job
   * picks a target instead of having a chat id pasted in.
   *
   * A credential — the daemon keeps it in the team secret store and reads it
   * back empty, where empty means "unchanged".
   */
  apiKey?: string
}

export interface WeComConfig {
  enabled: boolean
  /** New multi-bot list. Legacy single-bot fields below are migration-only. */
  bots: WeComBot[]
  // legacy single-bot fields (read-only fallback; written as bots[] going forward)
  botId?: string
  secret?: string
  encodingAesKey?: string
  ownerId?: string
}

export interface WeComBotStatus {
  botId: string
  connected: boolean
  error?: string
}

export type WeComGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WeComGatewayStatusResponse {
  status: WeComGatewayStatus
  errorMessage?: string
  botId?: string
  /** Active session keys (e.g. "wecom:dm:userid", "wecom:chatid") */
  activeSessions?: string[]
}

export interface WeComQrAuthStart {
  scode: string
  auth_url: string
}

export interface WeComQrAuthPollResult {
  status: 'waiting' | 'success' | 'expired'
  botId?: string
  secret?: string
}

// WeChat types
export interface WeChatConfig {
  enabled: boolean
  botToken: string
  accountId: string
  baseUrl: string
  syncBuf?: string
}

export type WeChatGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WeChatGatewayStatusResponse {
  status: WeChatGatewayStatus
  errorMessage?: string
  accountId?: string
}

// Channels configuration
export interface ChannelsConfig {
  discord?: DiscordConfig
  feishu?: FeishuConfig
  email?: EmailConfig
  kook?: KookConfig
  wecom?: WeComConfig
  wechat?: WeChatConfig
  seatalk?: SeaTalkConfig
}

// Gateway status response
export interface GatewayStatusResponse {
  status: GatewayStatus
  discordConnected: boolean
  errorMessage?: string
  connectedGuilds: string[]
  botUsername?: string
}

// Default configurations
export const defaultWeComConfig: WeComConfig = {
  enabled: false,
  bots: [],
}

export const defaultWeChatConfig: WeChatConfig = {
  enabled: false,
  botToken: '',
  accountId: '',
  baseUrl: 'https://ilinkai.weixin.qq.com',
}

export const defaultDmConfig: DmConfig = {
  enabled: true,
  policy: 'allowlist',
  allowFrom: [],
  groupEnabled: false,
  groupChannels: [],
}

export const defaultDiscordConfig: DiscordConfig = {
  enabled: false,
  token: '',
  dm: defaultDmConfig,
  guilds: {},
}

export const defaultFeishuConfig: FeishuConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  chats: {},
}

export const defaultSeaTalkConfig: SeaTalkConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  mode: 'websocket',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'open',
  groupAllowFrom: [],
}

export const defaultKookDmConfig: KookDmConfig = {
  enabled: false,
  policy: 'open',
  allowFrom: [],
}

export const defaultKookConfig: KookConfig = {
  enabled: false,
  token: '',
  dm: defaultKookDmConfig,
  guilds: {},
}

export const defaultEmailConfig: EmailConfig = {
  enabled: false,
  provider: 'gmail',
  gmailClientId: '',
  gmailClientSecret: '',
  gmailEmail: '',
  gmailAuthorized: false,
  imapServer: '',
  imapPort: 993,
  smtpServer: '',
  smtpPort: 465,
  username: '',
  password: '',
  recipientAlias: '',
  allowedSenders: [],
  labels: [],
  replyAllNew: false,
  displayName: `${appDisplayName} Agent`,
}

// Channels store state interface
export interface ChannelsState {
  discord: DiscordConfig | null
  isLoading: boolean
  error: string | null
  gatewayStatus: GatewayStatusResponse
  hasChanges: boolean
  isTesting: boolean
  testResult: { success: boolean; message: string } | null

  // Feishu state
  feishu: FeishuConfig | null
  feishuIsLoading: boolean
  feishuGatewayStatus: FeishuGatewayStatusResponse
  feishuHasChanges: boolean
  feishuIsTesting: boolean
  feishuTestResult: { success: boolean; message: string } | null

  // Email state
  email: EmailConfig | null
  emailIsLoading: boolean
  emailGatewayStatus: EmailGatewayStatusResponse
  emailHasChanges: boolean
  emailIsTesting: boolean
  emailTestResult: { success: boolean; message: string } | null
  /// Set when a Gmail OAuth flow is in progress and yup_oauth2 has produced
  /// the auth URL. Surfaced so the UI can display it for manual copy/paste
  /// when the system browser fails to auto-open. Cleared when the flow ends.
  gmailAuthUrl: string | null

  // KOOK state
  kook: KookConfig | null
  kookIsLoading: boolean
  kookGatewayStatus: KookGatewayStatusResponse
  kookHasChanges: boolean
  kookIsTesting: boolean
  kookTestResult: { success: boolean; message: string } | null

  // WeCom state
  wecom: WeComConfig | null
  wecomIsLoading: boolean
  wecomGatewayStatus: WeComGatewayStatusResponse
  wecomBotStatuses: WeComBotStatus[]
  wecomHasChanges: boolean
  wecomIsTesting: boolean
  wecomTestResult: { success: boolean; message: string } | null

  // WeChat state
  wechat: WeChatConfig | null
  wechatIsLoading: boolean
  wechatGatewayStatus: WeChatGatewayStatusResponse
  wechatHasChanges: boolean
  wechatIsTesting: boolean
  wechatTestResult: { success: boolean; message: string } | null

  // SeaTalk state
  seatalk: SeaTalkConfig | null
  seatalkIsLoading: boolean
  seatalkGatewayStatus: SeaTalkGatewayStatusResponse
  seatalkHasChanges: boolean
  seatalkIsTesting: boolean
  seatalkTestResult: { success: boolean; message: string } | null

  // Actions
  loadConfig: () => Promise<void>
  saveDiscordConfig: (config: DiscordConfig) => Promise<void>
  startGateway: () => Promise<void>
  stopGateway: () => Promise<void>
  refreshStatus: () => Promise<void>
  testToken: (token: string) => Promise<boolean>
  clearError: () => void
  clearTestResult: () => void
  setHasChanges: (hasChanges: boolean) => void

  // Feishu actions
  loadFeishuConfig: () => Promise<void>
  saveFeishuConfig: (config: FeishuConfig) => Promise<void>
  startFeishuGateway: () => Promise<void>
  stopFeishuGateway: () => Promise<void>
  refreshFeishuStatus: () => Promise<void>
  testFeishuCredentials: (appId: string, appSecret: string) => Promise<boolean>
  clearFeishuTestResult: () => void
  setFeishuHasChanges: (hasChanges: boolean) => void

  // Email actions
  loadEmailConfig: () => Promise<void>
  saveEmailConfig: (config: EmailConfig) => Promise<void>
  startEmailGateway: () => Promise<void>
  stopEmailGateway: () => Promise<void>
  refreshEmailStatus: () => Promise<void>
  testEmailConnection: (config: EmailConfig) => Promise<boolean>
  gmailAuthorize: (clientId: string, clientSecret: string, email: string) => Promise<boolean>
  checkGmailAuth: () => Promise<boolean>
  clearEmailTestResult: () => void
  setEmailHasChanges: (hasChanges: boolean) => void

  // KOOK actions
  loadKookConfig: () => Promise<void>
  saveKookConfig: (config: KookConfig) => Promise<void>
  startKookGateway: () => Promise<void>
  stopKookGateway: () => Promise<void>
  refreshKookStatus: () => Promise<void>
  testKookToken: (token: string) => Promise<boolean>
  clearKookTestResult: () => void
  setKookHasChanges: (hasChanges: boolean) => void

  // WeCom actions
  loadWecomConfig: () => Promise<void>
  saveWecomConfig: (config: WeComConfig) => Promise<void>
  startWecomGateway: () => Promise<void>
  stopWecomGateway: () => Promise<void>
  refreshWecomStatus: () => Promise<void>
  loadWecomBotStatuses: () => Promise<void>
  testWecomCredentials: (botId: string, secret: string) => Promise<boolean>
  clearWecomTestResult: () => void
  setWecomHasChanges: (hasChanges: boolean) => void
  startWecomQrAuth: () => Promise<WeComQrAuthStart>
  pollWecomQrAuth: (scode: string) => Promise<WeComQrAuthPollResult>

  // WeChat actions
  loadWechatConfig: () => Promise<void>
  saveWechatConfig: (config: WeChatConfig) => Promise<void>
  startWechatGateway: () => Promise<void>
  stopWechatGateway: () => Promise<void>
  refreshWechatStatus: () => Promise<void>
  testWechatConnection: (botToken: string) => Promise<boolean>
  clearWechatTestResult: () => void
  setWechatHasChanges: (hasChanges: boolean) => void

  // SeaTalk actions
  loadSeaTalkConfig: () => Promise<void>
  saveSeaTalkConfig: (config: SeaTalkConfig) => Promise<void>
  startSeaTalkGateway: () => Promise<void>
  stopSeaTalkGateway: () => Promise<void>
  refreshSeaTalkStatus: () => Promise<void>
  testSeaTalkCredentials: (appId: string, appSecret: string) => Promise<boolean>
  clearSeaTalkTestResult: () => void
  setSeaTalkHasChanges: (hasChanges: boolean) => void

  // Toggle enabled and persist immediately
  toggleDiscordEnabled: (enabled: boolean, config: DiscordConfig) => Promise<void>
  toggleFeishuEnabled: (enabled: boolean, config: FeishuConfig) => Promise<void>
  toggleEmailEnabled: (enabled: boolean, config: EmailConfig) => Promise<void>
  toggleKookEnabled: (enabled: boolean, config: KookConfig) => Promise<void>
  toggleWecomEnabled: (enabled: boolean, config: WeComConfig) => Promise<void>
  toggleWechatEnabled: (enabled: boolean, config: WeChatConfig) => Promise<void>
  toggleSeaTalkEnabled: (enabled: boolean, config: SeaTalkConfig) => Promise<void>

  // Auto-start enabled gateways
  autoStartEnabledGateways: () => Promise<void>

  // Keep-alive: check all enabled channels and restart if disconnected/errored
  keepAliveCheck: () => Promise<void>

  // Stop all gateways and reset state (for workspace switching)
  stopAllAndReset: () => Promise<void>
}
