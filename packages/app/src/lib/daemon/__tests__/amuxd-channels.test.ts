import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  AmuxdUnreachableError,
} from "@/lib/daemon/amuxd-channels";
import * as tauri from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("amuxd-channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws AmuxdUnreachableError when invoke rejects with reachability error", async () => {
    vi.mocked(tauri.invoke).mockRejectedValue("amuxd not reachable: foo");
    await expect(listChannels()).rejects.toBeInstanceOf(AmuxdUnreachableError);
  });

  it("returns channel array on success", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue([
      {
        platform: "discord",
        enabled: true,
        connected: false,
        lastError: null,
      },
    ]);
    const result = await listChannels();
    expect(result[0].platform).toBe("discord");
  });

  it("maps WeCom multi-bot config to daemon field names on save", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue(undefined);

    await saveChannelConfig("wecom", {
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          encodingAesKey: "aes",
        },
      ],
    });

    expect(tauri.invoke).toHaveBeenCalledWith("save_channel_config", {
      platform: "wecom",
      configJson: JSON.stringify({
        enabled: true,
        bots: [
          {
            enabled: true,
            bot_id: "bot",
            secret: "sec",
            encoding_aes_key: "aes",
          },
        ],
      }),
    });
  });

  it("round-trips the bot name and MCP key instead of dropping them", async () => {
    // This mapping is written field by field, so anything not listed here is
    // silently erased on the next save — which is exactly what happened to a
    // hand-written bot_name the first time the settings panel was saved.
    vi.mocked(tauri.invoke).mockResolvedValue(undefined);

    await saveChannelConfig("wecom", {
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          botName: "Matt chow的机器人 1",
          apiKey: "k-1",
        },
      ],
    });

    const [, args] = vi.mocked(tauri.invoke).mock.calls[0]!;
    const sent = JSON.parse((args as { configJson: string }).configJson);
    expect(sent.bots[0]).toMatchObject({
      bot_name: "Matt chow的机器人 1",
      api_key: "k-1",
    });

    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      bots: [
        {
          enabled: true,
          bot_id: "bot",
          secret: "sec",
          bot_name: "Matt chow的机器人 1",
          api_key: "k-1",
        },
      ],
    });
    await expect(loadChannelConfig("wecom")).resolves.toMatchObject({
      bots: [{ botName: "Matt chow的机器人 1", apiKey: "k-1" }],
    });
  });

  it("round-trips a SeaTalk system prompt and drops a blank one", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue(undefined);

    await saveChannelConfig("seatalk", {
      enabled: true,
      mode: "websocket",
      dmPolicy: "open",
      allowFrom: [],
      groupPolicy: "open",
      groupAllowFrom: [],
      bots: [
        {
          enabled: true,
          appId: "app001",
          appSecret: "sec",
          systemPrompt: "  只用中文回答。  ",
        },
      ],
    });

    const [, args] = vi.mocked(tauri.invoke).mock.calls[0]!;
    const sent = JSON.parse((args as { configJson: string }).configJson);
    expect(sent.app_id).toBeUndefined();
    expect(sent.bots).toEqual([
      {
        enabled: true,
        app_id: "app001",
        app_secret: "sec",
        system_prompt: "只用中文回答。",
      },
    ]);

    await saveChannelConfig("seatalk", {
      enabled: true,
      bots: [{ enabled: true, appId: "app001", appSecret: "sec", systemPrompt: "   " }],
    });
    const [, clearedArgs] = vi.mocked(tauri.invoke).mock.calls[1]!;
    const cleared = JSON.parse((clearedArgs as { configJson: string }).configJson);
    expect(cleared.bots[0].system_prompt).toBeUndefined();

    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      app_id: "app001",
      app_secret: "sec",
      mode: "websocket",
      dm_policy: "open",
      allow_from: [],
      group_policy: "open",
      group_allow_from: [],
      system_prompt: "只用中文回答。",
    });
    await expect(loadChannelConfig("seatalk")).resolves.toMatchObject({
      bots: [{ appId: "app001", systemPrompt: "只用中文回答。" }],
    });
  });

  it("maps the iPad-protocol WeChat channel separately from iLink WeChat", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue(undefined);

    await saveChannelConfig("wechatpad", {
      enabled: true,
      serverUrl: "http://127.0.0.1:3010",
      callbackPort: 9101,
      accountWxid: " wxid_bot ",
      loginAt: 1793089469,
      dmPolicy: "allowlist",
      allowFrom: ["wxid_me", "  ", " wxid_two "],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      model: "anthropic/claude",
    });
    const [command, args] = vi.mocked(tauri.invoke).mock.calls[0]!;
    expect(command).toBe("save_channel_config");
    expect((args as { platform: string }).platform).toBe("wechatpad");
    expect(JSON.parse((args as { configJson: string }).configJson)).toEqual({
      enabled: true,
      server_url: "http://127.0.0.1:3010",
      callback_port: 9101,
      account_wxid: "wxid_bot",
      login_at: 1793089469,
      dm_policy: "allowlist",
      allow_from: ["wxid_me", "wxid_two"],
      group_policy: "allowlist",
      group_allow_from: [],
      model: "anthropic/claude",
    });

    // A section that names no policy loads as allowlists, never as open.
    vi.mocked(tauri.invoke).mockResolvedValue({ enabled: false, account_wxid: "wxid_bot" });
    await expect(loadChannelConfig("wechatpad")).resolves.toEqual({
      enabled: false,
      serverUrl: "http://127.0.0.1:3010",
      callbackPort: 9101,
      accountWxid: "wxid_bot",
      dmPolicy: "allowlist",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    });
  });

  it("maps daemon WeCom multi-bot config back to app field names on load", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      bots: [
        {
          enabled: true,
          bot_id: "bot",
          secret: "sec",
          encoding_aes_key: "aes",
        },
      ],
    });

    await expect(loadChannelConfig("wecom")).resolves.toEqual({
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          encodingAesKey: "aes",
        },
      ],
    });
  });

  it("migrates legacy single-bot WeCom daemon config on load", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      bot_id: "bot",
      secret: "sec",
      encoding_aes_key: "aes",
    });

    await expect(loadChannelConfig("wecom")).resolves.toEqual({
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          encodingAesKey: "aes",
        },
      ],
    });
  });

  it("round-trips workspace and model for a channel and a WeCom bot", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue(undefined);

    await saveChannelConfig("discord", {
      enabled: true,
      token: "tok",
      dm: { enabled: false, policy: "open", allowFrom: [] },
      guilds: {},
      workspaceId: " ws-1 ",
      model: " anthropic/claude ",
    });

    const [, discordArgs] = vi.mocked(tauri.invoke).mock.calls[0]!;
    const discord = JSON.parse((discordArgs as { configJson: string }).configJson);
    expect(discord.workspace_id).toBe("ws-1");
    expect(discord.model).toBe("anthropic/claude");

    await saveChannelConfig("wecom", {
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          workspaceId: "ws-bot",
          model: "pi/deepseek",
        },
      ],
    });
    const [, wecomArgs] = vi.mocked(tauri.invoke).mock.calls[1]!;
    const wecom = JSON.parse((wecomArgs as { configJson: string }).configJson);
    expect(wecom.bots[0]).toMatchObject({
      workspace_id: "ws-bot",
      model: "pi/deepseek",
    });

    await saveChannelConfig("feishu", {
      enabled: true,
      appId: "app",
      appSecret: "sec",
      workspaceId: "   ",
      model: "",
    });
    const [, blankArgs] = vi.mocked(tauri.invoke).mock.calls[2]!;
    const blank = JSON.parse((blankArgs as { configJson: string }).configJson);
    expect(blank.workspace_id).toBeUndefined();
    expect(blank.model).toBeUndefined();

    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      bot_token: "tok",
      workspace_id: "ws-1",
      model: "anthropic/claude",
    });
    await expect(loadChannelConfig("discord")).resolves.toMatchObject({
      workspaceId: "ws-1",
      model: "anthropic/claude",
    });
  });
});
