/**
 * Repro tests for the mid-turn follow-up bug: a second user message while
 * opencode is still processing can drop the Composer live panel and skip
 * late toolUse events.
 *
 * Run against a live daemon:
 *   REPRO_MID_TURN_LIVE=1 pnpm --filter @teamclu/app exec vitest run src/lib/__tests__/mid-turn-followup-repro.test.ts
 * or:
 *   scripts/repro-mid-turn-followup.sh [--session-id <uuid>]
 */
import { describe, it, expect, beforeEach } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
  MessageSchema,
  MessageKind,
} from "@/lib/proto/teamclu_pb";
import { AgentStatus } from "@/lib/proto/amux_pb";
import { decodeLiveEvent } from "@/lib/daemon/teamclu-events";
import {
  clearFlushedTurn,
  registerFlushedTurn,
  resetFlushedTurnRegistryForTests,
} from "@/lib/stream/flushed-turn-registry";
import { shouldPatchFlushedToolEvent } from "@/lib/stream/live-agent-stream";
import {
  isStreamInterruptible,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import { useSessionMessageStore } from "@/stores/session-message-store";

const LIVE = process.env.REPRO_MID_TURN_LIVE === "1";
const AMUXD_DIR = path.join(os.homedir(), ".amuxd");

function resetStreamingStore() {
  useV2StreamingStore.setState({
    byKey: {},
    archived: [],
    revisionBySession: {},
    interruptedFlushPending: {},
    persistedPlansBySession: {},
  });
}

function readAmuxdHttpBase(): string {
  const port = fs.readFileSync(path.join(AMUXD_DIR, "run", "amuxd.http.port"), "utf8").trim();
  return `http://127.0.0.1:${port}`;
}

function readAmuxdRootToken(): string {
  return fs.readFileSync(path.join(AMUXD_DIR, "run", "amuxd.http.token"), "utf8").trim();
}

async function exchangeScopedToken(scopes: string[]): Promise<string> {
  const res = await fetch(`${readAmuxdHttpBase()}/v1/auth/exchange`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readAmuxdRootToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scopes }),
  });
  if (!res.ok) {
    throw new Error(`auth exchange failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("auth exchange returned no token");
  return body.token;
}

async function fetchDaemonInfo(token: string): Promise<{ actor_id: string; mqtt_connected: boolean }> {
  const res = await fetch(`${readAmuxdHttpBase()}/v1/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`info failed (${res.status})`);
  return res.json() as Promise<{ actor_id: string; mqtt_connected: boolean }>;
}

function defaultSessionId(): string {
  const fromEnv = process.env.REPRO_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;
  const activePath = path.join(
    os.homedir(),
    ".amuxd/teams/68c9c97a-7393-494f-9b82-59364e7179ba/workspace/.teamclu/active-session-id",
  );
  if (fs.existsSync(activePath)) {
    const id = fs.readFileSync(activePath, "utf8").trim();
    if (id) return id;
  }
  throw new Error("Set REPRO_SESSION_ID or open a session in TeamClu first");
}

function buildMessageCreatedEnvelope(args: {
  sessionId: string;
  senderActorId: string;
  daemonActorId: string;
  content: string;
  messageId?: string;
}): Uint8Array {
  const messageId = args.messageId ?? randomUUID();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const message = create(MessageSchema, {
    messageId,
    sessionId: args.sessionId,
    senderActorId: args.senderActorId,
    kind: MessageKind.TEXT,
    content: args.content,
    createdAt: nowSec,
  });
  const sessionMsg = create(SessionMessageEnvelopeSchema, {
    message,
    mentionActorIds: [args.daemonActorId],
  });
  const live = create(LiveEventEnvelopeSchema, {
    eventId: randomUUID(),
    eventType: "message.created",
    sessionId: args.sessionId,
    actorId: args.senderActorId,
    sentAt: nowSec,
    body: toBinary(SessionMessageEnvelopeSchema, sessionMsg),
  });
  return toBinary(LiveEventEnvelopeSchema, live);
}

async function ingestMessage(token: string, sessionId: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(
    `${readAmuxdHttpBase()}/v1/session-live/ingest?session_id=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-protobuf",
      },
      body: bytes as unknown as BodyInit,
    },
  );
  if (!res.ok) {
    throw new Error(`live ingest failed (${res.status}): ${await res.text()}`);
  }
}

type LiveEventRecord = {
  at: number;
  topic: string;
  eventType: string;
  oldStatus?: AgentStatus;
  newStatus?: AgentStatus;
  toolName?: string;
  outputSnippet?: string;
};

function summarizeAcpEvent(decoded: ReturnType<typeof decodeLiveEvent>): Partial<LiveEventRecord> {
  if (!decoded?.acpEvent) return {};
  const ev = decoded.acpEvent.event;
  if (ev?.case === "statusChange") {
    return { oldStatus: ev.value.oldStatus, newStatus: ev.value.newStatus };
  }
  if (ev?.case === "toolUse") {
    const tu = ev.value as { toolName?: string; toolId?: string };
    return { toolName: tu.toolName ?? tu.toolId ?? "tool" };
  }
  if (ev?.case === "output") {
    const text = (ev.value as { text?: string }).text ?? "";
    return { outputSnippet: text.slice(0, 80) };
  }
  return {};
}

describe("mid-turn follow-up repro (client store simulation)", () => {
  beforeEach(() => {
    resetFlushedTurnRegistryForTests();
    resetStreamingStore();
  });

  it("terminal flush with inactive live stream gates late toolUse (matches mqtt.toolUse.skipAfterFlush)", () => {
    const sessionId = "s1";
    const actorId = "agent-1";
    const store = useV2StreamingStore.getState();

    store.beginPlanningPlaceholder(sessionId, actorId);
    store.appendOutput(sessionId, actorId, "Turn 1 output");
    store.pushToolUse(sessionId, actorId, {
      toolId: "tool-1",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });

    const beforeFlush = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    expect(isStreamInterruptible(beforeFlush)).toBe(true);
    expect(beforeFlush.toolCalls).toHaveLength(1);

    registerFlushedTurn(sessionId, actorId, {
      messageId: "msg-flushed",
      streamId: beforeFlush.streamId,
      turnId: "turn-1",
    });
    store.finishSessionActor(sessionId, actorId);

    const liveEntry = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    expect(liveEntry?.active ?? false).toBe(false);

    const wouldSkipLateToolUse = shouldPatchFlushedToolEvent(
      sessionId,
      actorId,
      "tool-late",
      liveEntry,
    );
    expect(wouldSkipLateToolUse).toBe(true);
  });

  it("second ACTIVE after flush clears registry but beginPlanning skips when turn1 still has content", () => {
    const sessionId = "s1";
    const actorId = "agent-1";
    const store = useV2StreamingStore.getState();

    store.beginPlanningPlaceholder(sessionId, actorId);
    store.appendOutput(sessionId, actorId, "In-flight text");

    clearFlushedTurn(sessionId, actorId);
    store.beginPlanningPlaceholder(sessionId, actorId);

    const entry = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    expect(entry.outputText).toBe("In-flight text");
    expect(isStreamInterruptible(entry)).toBe(true);
  });

  it("race: terminal flush after second ACTIVE hides live panel and drops late toolUse", async () => {
    const sessionId = "s1";
    const actorId = "agent-1";
    const store = useV2StreamingStore.getState();

    store.beginPlanningPlaceholder(sessionId, actorId);
    store.appendOutput(sessionId, actorId, "Step 1");
    store.pushToolUse(sessionId, actorId, {
      toolId: "tool-1",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });

    const turn1 = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];

    clearFlushedTurn(sessionId, actorId);
    store.beginPlanningPlaceholder(sessionId, actorId);

    const reply = create(MessageSchema, {
      messageId: "msg-flushed",
      sessionId,
      senderActorId: actorId,
      kind: MessageKind.AGENT_REPLY,
      content: "Step 1",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });
    Object.assign(reply, {
      partsJson: JSON.stringify([
        { id: "p1", type: "text", text: "Step 1", content: "Step 1" },
      ]),
    });
    useSessionMessageStore.getState().replaceTurnAgentRepliesInStore(sessionId, reply);
    registerFlushedTurn(sessionId, actorId, {
      messageId: "msg-flushed",
      streamId: turn1.streamId,
      turnId: "turn-1",
    });
    store.finishSessionActor(sessionId, actorId);

    const liveAfter = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    expect(liveAfter?.active ?? false).toBe(false);

    const { patchPersistedToolUse } = await import("@/lib/stream/streaming-persist");
    const patched = await patchPersistedToolUse({
      sessionId,
      actorId,
      toolId: "tool-late",
      toolName: "grep",
      description: "late search",
      params: { pattern: "foo" },
      toolKind: "search",
    });
    expect(patched).toBe(true);

    const stored = useSessionMessageStore.getState().messages[sessionId]?.[0] as {
      partsJson?: string;
    };
    const parts = JSON.parse(stored.partsJson ?? "[]");
    expect(parts.some((p: { toolCall?: { id?: string } }) => p.toolCall?.id === "tool-late")).toBe(
      true,
    );
  });

  it("follow-up beginPlanning after flush reopens empty active dock", () => {
    const sessionId = "s1";
    const actorId = "agent-1";
    const store = useV2StreamingStore.getState();

    store.beginPlanningPlaceholder(sessionId, actorId);
    store.appendOutput(sessionId, actorId, "Turn 1 still running");
    store.beginPlanningPlaceholder(sessionId, actorId);

    const midTurn = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    expect(midTurn.outputText).toBe("Turn 1 still running");

    store.finishSessionActor(sessionId, actorId);
    store.beginPlanningPlaceholder(sessionId, actorId);

    const entry = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    expect(entry?.active).toBe(true);
    expect(entry.outputText).toBe("");
  });
});

const liveDescribe = LIVE ? describe : describe.skip;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

liveDescribe("mid-turn follow-up repro (live daemon)", () => {
  it(
    "double prompt while turn active emits repeated Idle→Active and can lose post-flush toolUse",
    async () => {
      const token = await exchangeScopedToken([
        "sessions:read",
        "sessions:write",
        "events:read",
      ]);
      const info = await fetchDaemonInfo(token);
      expect(info.mqtt_connected).toBe(true);

      const sessionId = defaultSessionId();
      const daemonActorId = info.actor_id;
      const userActorId = "repro-user-" + randomUUID().slice(0, 8);

      const msg1 = buildMessageCreatedEnvelope({
        sessionId,
        senderActorId: userActorId,
        daemonActorId,
        content:
          "请用 grep 或 bash 工具列出当前 workspace 根目录下的文件（必须调用工具），然后简短总结。",
      });
      const msg2 = buildMessageCreatedEnvelope({
        sessionId,
        senderActorId: userActorId,
        daemonActorId,
        content: "补充：完成后也检查一下 package.json 是否存在（继续用工具）。",
      });

      const events: LiveEventRecord[] = [];
      const url = `${readAmuxdHttpBase()}/v1/live/events?access_token=${encodeURIComponent(token)}`;
      const controller = new AbortController();

      const sseTask = (async () => {
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`live/events failed (${res.status})`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf("\n\n");
            while (idx >= 0) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
              if (dataLine) {
                try {
                  const frame = JSON.parse(dataLine.slice(6)) as { topic?: string; b64?: string };
                  if (!frame.b64) continue;
                  const payload = Uint8Array.from(atob(frame.b64), (c) => c.charCodeAt(0));
                  const decoded = decodeLiveEvent(payload);
                  const sid =
                    decoded?.envelope.sessionId ??
                    (frame.topic?.match(/session\/([^/]+)\/live/)?.[1] ?? "");
                  if (sid && sid !== sessionId) continue;
                  events.push({
                    at: Date.now(),
                    topic: frame.topic ?? "",
                    eventType: decoded?.envelope.eventType ?? "unknown",
                    ...summarizeAcpEvent(decoded),
                  });
                } catch {
                  // ignore
                }
              }
              idx = buffer.indexOf("\n\n");
            }
          }
        } catch (err) {
          if (!isAbortError(err)) throw err;
        }
      })();

      await ingestMessage(token, sessionId, msg1);

      const waitUntil = async (predicate: () => boolean, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      };

      await waitUntil(
        () =>
          events.some(
            (e) =>
              e.eventType === "acp.event" &&
              e.oldStatus === AgentStatus.IDLE &&
              e.newStatus === AgentStatus.ACTIVE,
          ),
        30_000,
      );

      await waitUntil(() => events.some((e) => e.toolName || e.outputSnippet), 20_000);

      await ingestMessage(token, sessionId, msg2);

      await waitUntil(
        () =>
          events.filter(
            (e) =>
              e.eventType === "acp.event" &&
              e.oldStatus === AgentStatus.IDLE &&
              e.newStatus === AgentStatus.ACTIVE,
          ).length >= 2,
        15_000,
      );

      await new Promise((r) => setTimeout(r, 3_000));
      controller.abort();
      await sseTask;

      const idleToActive = events.filter(
        (e) =>
          e.eventType === "acp.event" &&
          e.oldStatus === AgentStatus.IDLE &&
          e.newStatus === AgentStatus.ACTIVE,
      );
      const activeToIdle = events.filter(
        (e) =>
          e.eventType === "acp.event" &&
          e.oldStatus === AgentStatus.ACTIVE &&
          e.newStatus === AgentStatus.IDLE,
      );
      const toolUses = events.filter((e) => e.toolName);
      const outputs = events.filter((e) => e.outputSnippet);

      console.log("[repro] session", sessionId);
      console.log("[repro] Idle→Active count", idleToActive.length);
      console.log("[repro] Active→Idle count", activeToIdle.length);
      console.log("[repro] toolUse events", toolUses.length, toolUses.map((t) => t.toolName));
      console.log("[repro] output events", outputs.length);

      if (idleToActive.length >= 2) {
        const secondActiveAt = idleToActive[1]?.at ?? 0;
        const toolUsesAfterSecondActive = toolUses.filter((t) => t.at >= secondActiveAt);
        console.log(
          "[repro] toolUse after 2nd Idle→Active",
          toolUsesAfterSecondActive.length,
        );
      } else {
        console.warn(
          "[repro] only one Idle→Active — runtime may not have been mid-turn; retry while agent is busy",
        );
      }

      expect(events.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
