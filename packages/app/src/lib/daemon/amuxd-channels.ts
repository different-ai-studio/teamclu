import { invoke } from "@tauri-apps/api/core";

type ChannelPlatform =
  | "discord"
  | "wecom"
  | "feishu"
  | "kook"
  | "wechat"
  | "email"
  | "seatalk";

export interface ChannelStatus {
  platform: ChannelPlatform;
  enabled: boolean;
  connected: boolean;
  lastError: string | null;
}

type ChannelConfig = Record<string, unknown>;

function runtimeToDaemon(config: ChannelConfig): ChannelConfig {
  const workspaceId = typeof config.workspaceId === "string" ? config.workspaceId.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  return {
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(model ? { model } : {}),
  };
}

function runtimeFromDaemon(config: ChannelConfig): ChannelConfig {
  const workspaceId =
    typeof config.workspace_id === "string" ? config.workspace_id.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(model ? { model } : {}),
  };
}

export async function listChannels(): Promise<ChannelStatus[]> {
  try {
    return await invoke<ChannelStatus[]>("list_channels");
  } catch (e) {
    if (isUnreachableError(e)) throw new AmuxdUnreachableError();
    throw e;
  }
}

export async function loadChannelConfig<T extends object>(
  platform: ChannelPlatform,
): Promise<Partial<T> | null> {
  try {
    const config = await invoke<ChannelConfig | null>("load_channel_config", {
      platform,
    });
    return config ? (fromDaemonConfig(platform, config) as Partial<T>) : null;
  } catch (e) {
    if (isUnreachableError(e)) throw new AmuxdUnreachableError();
    throw e;
  }
}

export async function saveChannelConfig(
  platform: ChannelPlatform,
  config: object,
): Promise<void> {
  try {
    await invoke("save_channel_config", {
      platform,
      configJson: JSON.stringify(toDaemonConfig(platform, config as ChannelConfig)),
    });
  } catch (e) {
    if (isUnreachableError(e)) throw new AmuxdUnreachableError();
    throw e;
  }
}

/**
 * The model every gateway session starts on when the chat has not set its own
 * with `/model` (ADR-0007). `null` = unset, which leaves the spawn unpinned and
 * lets the backend pick — the behaviour this setting exists to replace.
 *
 * Gateway-level rather than per-platform: the platforms differ in how a message
 * arrives, not in what should answer it.
 */
export async function loadGatewayModel(): Promise<string | null> {
  try {
    return await invoke<string | null>("load_gateway_model");
  } catch (e) {
    if (isUnreachableError(e)) throw new AmuxdUnreachableError();
    throw e;
  }
}

/** Empty string clears it, restoring the unpinned spawn. */
export async function saveGatewayModel(model: string): Promise<void> {
  try {
    await invoke("save_gateway_model", { model });
  } catch (e) {
    if (isUnreachableError(e)) throw new AmuxdUnreachableError();
    throw e;
  }
}

export async function reloadChannels(): Promise<void> {
  try {
    await invoke("reload_channels");
  } catch (e) {
    if (isUnreachableError(e)) throw new AmuxdUnreachableError();
    throw e;
  }
}

function toDaemonConfig(platform: ChannelPlatform, config: ChannelConfig): ChannelConfig {
  switch (platform) {
    case "discord":
      return {
        enabled: Boolean(config.enabled),
        bot_token: String(config.token ?? ""),
        default_username: config.defaultUsername ?? null,
        ...runtimeToDaemon(config),
      };
    case "wecom": {
      const bots = Array.isArray(config.bots) ? (config.bots as ChannelConfig[]) : [];
      return {
        enabled: Boolean(config.enabled),
        bots: bots.map((b) => ({
          enabled: Boolean(b.enabled),
          bot_id: String(b.botId ?? ""),
          secret: String(b.secret ?? ""),
          encoding_aes_key: b.encodingAesKey || undefined,
          system_prompt: b.systemPrompt || undefined,
          bot_name: b.botName || undefined,
          api_key: b.apiKey || undefined,
          ...runtimeToDaemon(b),
        })),
      };
    }
    case "feishu":
      return {
        enabled: Boolean(config.enabled),
        app_id: String(config.appId ?? ""),
        app_secret: String(config.appSecret ?? ""),
        ...runtimeToDaemon(config),
      };
    case "seatalk": {
      const bots = Array.isArray(config.bots) ? (config.bots as ChannelConfig[]) : [];
      return {
        enabled: Boolean(config.enabled),
        mode: String(config.mode ?? "websocket"),
        dm_policy: String(config.dmPolicy ?? "open"),
        allow_from: Array.isArray(config.allowFrom) ? config.allowFrom : [],
        group_policy: String(config.groupPolicy ?? "open"),
        group_allow_from: Array.isArray(config.groupAllowFrom)
          ? config.groupAllowFrom
          : [],
        bots: bots.map((b) => ({
          enabled: b.enabled !== false,
          app_id: String(b.appId ?? ""),
          app_secret: String(b.appSecret ?? ""),
          system_prompt: String(b.systemPrompt ?? "").trim() || undefined,
          ...runtimeToDaemon(b),
        })),
      };
    }
    case "kook":
      return {
        enabled: Boolean(config.enabled),
        bot_token: String(config.token ?? ""),
        ...runtimeToDaemon(config),
      };
    case "wechat":
      return {
        enabled: Boolean(config.enabled),
        ilink_account: String(config.accountId ?? ""),
        ilink_token: String(config.botToken ?? ""),
        ...runtimeToDaemon(config),
      };
    case "email":
      return {
        enabled: Boolean(config.enabled),
        imap_host: String(config.imapServer ?? ""),
        imap_port: Number(config.imapPort ?? 993),
        imap_user: String(config.username ?? ""),
        imap_pass: String(config.password ?? ""),
        smtp_host: String(config.smtpServer ?? ""),
        smtp_port: Number(config.smtpPort ?? 587),
        smtp_user: String(config.username ?? ""),
        smtp_pass: String(config.password ?? ""),
        allowed_senders: Array.isArray(config.allowedSenders)
          ? config.allowedSenders
          : [],
        ...runtimeToDaemon(config),
      };
  }
}

function seatalkPrompt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Prefer `bots`. An older document with only `app_id` becomes one bot. */
function seatalkBotsFromDaemon(config: ChannelConfig): ChannelConfig[] {
  const raw = config.bots;
  if (Array.isArray(raw) && raw.length > 0) {
    return (raw as ChannelConfig[]).map((b) => ({
      enabled: b.enabled !== false,
      appId: String(b.app_id ?? ""),
      appSecret: String(b.app_secret ?? ""),
      systemPrompt: seatalkPrompt(b.system_prompt),
      ...runtimeFromDaemon(b),
    }));
  }
  const appId = String(config.app_id ?? "");
  if (!appId) return [];
  return [
    {
      enabled: true,
      appId,
      appSecret: String(config.app_secret ?? ""),
      systemPrompt: seatalkPrompt(config.system_prompt),
    },
  ];
}

function fromDaemonConfig(platform: ChannelPlatform, config: ChannelConfig): ChannelConfig {
  switch (platform) {
    case "discord":
      return {
        enabled: Boolean(config.enabled),
        token: String(config.bot_token ?? ""),
        defaultUsername: config.default_username ?? undefined,
        ...runtimeFromDaemon(config),
      };
    case "wecom": {
      const rawBots = config.bots;
      if (Array.isArray(rawBots) && rawBots.length > 0) {
        return {
          enabled: Boolean(config.enabled),
          bots: (rawBots as ChannelConfig[]).map((b) => ({
            enabled: b.enabled ?? true,
            botId: String(b.bot_id ?? ""),
            secret: String(b.secret ?? ""),
            encodingAesKey: b.encoding_aes_key ?? undefined,
            systemPrompt: b.system_prompt ?? undefined,
            botName: b.bot_name ?? undefined,
            apiKey: b.api_key ?? undefined,
            ...runtimeFromDaemon(b),
          })),
        };
      }
      // Legacy single-bot migration: top-level bot_id/secret/encoding_aes_key
      const legacy = config.bot_id
        ? [
            {
              enabled: true,
              botId: String(config.bot_id),
              secret: String(config.secret ?? ""),
              encodingAesKey: config.encoding_aes_key ?? undefined,
            },
          ]
        : [];
      return {
        enabled: Boolean(config.enabled),
        bots: legacy,
      };
    }
    case "feishu":
      return {
        enabled: Boolean(config.enabled),
        appId: String(config.app_id ?? ""),
        appSecret: String(config.app_secret ?? ""),
        ...runtimeFromDaemon(config),
      };
    case "seatalk":
      return {
        enabled: Boolean(config.enabled),
        mode: String(config.mode ?? "websocket"),
        dmPolicy: String(config.dm_policy ?? "open"),
        allowFrom: Array.isArray(config.allow_from) ? config.allow_from : [],
        groupPolicy: String(config.group_policy ?? "open"),
        groupAllowFrom: Array.isArray(config.group_allow_from)
          ? config.group_allow_from
          : [],
        bots: seatalkBotsFromDaemon(config),
      };
    case "kook":
      return {
        enabled: Boolean(config.enabled),
        token: String(config.bot_token ?? ""),
        ...runtimeFromDaemon(config),
      };
    case "wechat":
      return {
        enabled: Boolean(config.enabled),
        accountId: String(config.ilink_account ?? ""),
        botToken: String(config.ilink_token ?? ""),
        ...runtimeFromDaemon(config),
      };
    case "email":
      return {
        enabled: Boolean(config.enabled),
        provider: "custom",
        imapServer: String(config.imap_host ?? ""),
        imapPort: Number(config.imap_port ?? 993),
        smtpServer: String(config.smtp_host ?? ""),
        smtpPort: Number(config.smtp_port ?? 587),
        username: String(config.imap_user ?? config.smtp_user ?? ""),
        password: String(config.imap_pass ?? config.smtp_pass ?? ""),
        allowedSenders: Array.isArray(config.allowed_senders)
          ? config.allowed_senders
          : [],
        ...runtimeFromDaemon(config),
      };
  }
}

export class AmuxdUnreachableError extends Error {
  constructor() {
    super("amuxd unreachable");
    this.name = "AmuxdUnreachableError";
  }
}

function isUnreachableError(e: unknown): boolean {
  if (e instanceof Error) return /amuxd not reachable/i.test(e.message);
  if (typeof e === "string") return /amuxd not reachable/i.test(e);
  return false;
}
