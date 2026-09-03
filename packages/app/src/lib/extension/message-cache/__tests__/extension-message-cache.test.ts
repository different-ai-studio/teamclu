import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("../chrome-storage", () => ({
  readChromeStorageLocal: () => ({
    get: async (keys?: string | string[] | null) => {
      const out: Record<string, unknown> = {};
      const list = Array.isArray(keys) ? keys : keys ? [keys] : [...store.keys()];
      for (const key of list) {
        if (store.has(key)) out[key] = store.get(key);
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  }),
}));

import {
  loadExtensionMessagesForSession,
  pruneExtensionMessageCache,
  setExtensionMessageParts,
  upsertExtensionMessagesBatch,
} from "../index";
import { pickSessionsToEvict } from "../evict";
import {
  emptyMeta,
  MAX_BYTES,
  MAX_SESSIONS,
  META_KEY,
  sessionStorageKey,
  type ExtensionMessageCacheMeta,
} from "../types";
import type { MessageRow } from "@/lib/cache/local-cache";

function row(
  overrides: Partial<MessageRow> & Pick<MessageRow, "id" | "sessionId">,
): MessageRow {
  const now = new Date().toISOString();
  return {
    teamId: "team-1",
    kind: "agent_reply",
    content: "Done.",
    origin: "mqtt-live",
    createdAt: now,
    updatedAt: now,
    syncedAt: now,
    ...overrides,
  };
}

describe("pickSessionsToEvict", () => {
  it("evicts oldest sessions beyond MAX_SESSIONS", () => {
    const meta = emptyMeta();
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      meta.sessions[`s${i}`] = { lastAccessAt: i, bytes: 10 };
    }
    const victims = pickSessionsToEvict(meta, { protectSessionId: "s22" });
    expect(victims).toEqual(["s0", "s1", "s2"]);
    expect(victims).not.toContain("s22");
  });

  it("evicts until under byte budget", () => {
    const meta = emptyMeta();
    meta.sessions.a = { lastAccessAt: 1, bytes: MAX_BYTES };
    meta.sessions.b = { lastAccessAt: 2, bytes: 100 };
    const victims = pickSessionsToEvict(meta, { protectSessionId: "b" });
    expect(victims).toEqual(["a"]);
  });
});

describe("extension message cache", () => {
  beforeEach(() => {
    store.clear();
  });

  it("upserts and loads messages for a session", async () => {
    await upsertExtensionMessagesBatch([
      row({ id: "m1", sessionId: "sess-a", content: "hi" }),
    ]);
    const loaded = await loadExtensionMessagesForSession("sess-a");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("hi");
  });

  it("COALESCE keeps local partsJson when cloud row has none", async () => {
    await upsertExtensionMessagesBatch([
      row({
        id: "m1",
        sessionId: "sess-a",
        partsJson: JSON.stringify([{ type: "reasoning", text: "think" }]),
      }),
    ]);
    await upsertExtensionMessagesBatch([
      row({ id: "m1", sessionId: "sess-a", content: "Done.", partsJson: null }),
    ]);
    const loaded = await loadExtensionMessagesForSession("sess-a");
    expect(loaded[0]?.partsJson).toContain("reasoning");
    expect(loaded[0]?.content).toBe("Done.");
  });

  it("setMessageParts attaches parts onto an existing row", async () => {
    await upsertExtensionMessagesBatch([
      row({ id: "m1", sessionId: "sess-a" }),
    ]);
    const partsJson = JSON.stringify([
      { type: "tool-call", toolCall: { id: "t1", name: "sleep" } },
    ]);
    await setExtensionMessageParts("m1", partsJson);
    const loaded = await loadExtensionMessagesForSession("sess-a");
    expect(loaded[0]?.partsJson).toBe(partsJson);
  });

  it("prunes LRU sessions over the cap", async () => {
    for (let i = 0; i < MAX_SESSIONS + 2; i++) {
      await upsertExtensionMessagesBatch([
        row({ id: `m${i}`, sessionId: `sess-${i}`, content: `c${i}` }),
      ]);
    }
    const meta = store.get(META_KEY) as ExtensionMessageCacheMeta;
    expect(Object.keys(meta.sessions).length).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(store.has(sessionStorageKey("sess-0"))).toBe(false);
  });

  it("pruneExtensionMessageCache can run on open", async () => {
    store.set(META_KEY, {
      version: 1,
      sessions: Object.fromEntries(
        Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => [
          `sess-${i}`,
          { lastAccessAt: i, bytes: 10 },
        ]),
      ),
      idIndex: {},
    } satisfies ExtensionMessageCacheMeta);
    for (let i = 0; i < MAX_SESSIONS + 1; i++) {
      store.set(sessionStorageKey(`sess-${i}`), [
        row({ id: `m${i}`, sessionId: `sess-${i}` }),
      ]);
    }
    const victims = await pruneExtensionMessageCache({
      protectSessionId: `sess-${MAX_SESSIONS}`,
    });
    expect(victims.length).toBeGreaterThan(0);
    expect(victims).toContain("sess-0");
  });
});
