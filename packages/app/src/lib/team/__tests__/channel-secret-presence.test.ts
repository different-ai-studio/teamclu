import { describe, expect, it, vi, beforeEach } from "vitest";
import * as tauri from "@tauri-apps/api/core";
import {
  botSecretPath,
  channelSecretPath,
  loadChannelSecretKeys,
} from "@/lib/team/channel-secret-presence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("channel secret presence", () => {
  beforeEach(() => vi.resetAllMocks());

  it("builds the paths the daemon stores credentials under", () => {
    // The bot id, not the array index: deleting bot 0 must not hand bot 1
    // someone else's slot.
    expect(botSecretPath("wecom", "aibC1", "api_key")).toBe(
      "channels.wecom.bots[aibC1].api_key",
    );
    expect(channelSecretPath("feishu", "app_secret")).toBe(
      "channels.feishu.app_secret",
    );
  });

  it("reports nothing rather than guessing when the daemon is unreachable", async () => {
    // "Configured" on a guess would tell someone their key is safe when the
    // store was never read.
    vi.mocked(tauri.invoke).mockRejectedValue(new Error("amuxd not reachable"));
    await expect(loadChannelSecretKeys()).resolves.toEqual(new Set());
  });

  it("turns the daemon's list into a lookup", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue([
      "channels.wecom.bots[b1].secret",
      "channels.feishu.app_secret",
    ]);
    const keys = await loadChannelSecretKeys();
    expect(keys.has("channels.wecom.bots[b1].secret")).toBe(true);
    expect(keys.has("channels.wecom.bots[b1].api_key")).toBe(false);
  });
});
