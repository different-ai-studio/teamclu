import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeJs } from "../../_utils/tauri-mcp-test-utils";
import {
  cleanupV2,
  clickSelector,
  domCount,
  domText,
  expandStreamingTool,
  launchV2E2EApp,
  stopV2E2EApp,
  v2Call,
  waitForSelector,
  waitForText,
} from "../_utils/v2-app";

const RUN_PREFIX = `v2-pr-critical-${Date.now().toString(36)}`;
let runSeq = 0;

type ActorSeed = {
  id: string;
  actorType: "member" | "agent";
  displayName: string;
};

type SessionSeed = {
  id: string;
  title: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  participantActorIds: string[];
};

type MessageSeed = {
  messageId: string;
  senderActorId: string;
  kind: "text" | "agent_reply";
  content: string;
  createdAt: string;
  model?: string;
  turnId?: string;
};

function nextRunId(label: string): string {
  runSeq += 1;
  return `${RUN_PREFIX}-${runSeq}-${label}`;
}

function id(runId: string, suffix: string): string {
  return `${runId}-${suffix}`;
}

async function jsJson<T>(code: string): Promise<T> {
  return JSON.parse(await executeJs(code)) as T;
}

async function waitFor<T>(
  description: string,
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      lastValue = await probe();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const details = lastError instanceof Error ? lastError.message : JSON.stringify(lastValue);
  throw new Error(`Timed out waiting for ${description}: ${details}`);
}

function rowSelector(sessionId: string): string {
  return `[data-testid="v2-session-row"][data-session-id="${sessionId}"]`;
}

async function rowIds(): Promise<string[]> {
  return jsJson<string[]>(`
    (() => JSON.stringify(
      Array.from(document.querySelectorAll('[data-testid="v2-session-row"]'))
        .map((el) => el.getAttribute('data-session-id') || '')
        .filter(Boolean)
    ))()
  `);
}

async function attr(selector: string, name: string): Promise<string | null> {
  return jsJson<string | null>(`
    (() => JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null))()
  `);
}

async function textOccurrences(selector: string, text: string): Promise<number> {
  return jsJson<number>(`
    (() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const haystack = root?.textContent ?? "";
      const needle = ${JSON.stringify(text)};
      if (!needle) return JSON.stringify(0);
      let count = 0;
      let index = 0;
      while ((index = haystack.indexOf(needle, index)) !== -1) {
        count += 1;
        index += needle.length;
      }
      return JSON.stringify(count);
    })()
  `);
}

async function seedConversation(input: {
  runId: string;
  actors: ActorSeed[];
  sessions: SessionSeed[];
  messagesBySession?: Record<string, MessageSeed[]>;
  activeSessionId?: string;
}): Promise<void> {
  await v2Call("seedConversation", {
    runId: input.runId,
    teamId: `${input.runId}-team`,
    workspacePath: `/tmp/${input.runId}-workspace`,
    actors: input.actors,
    sessions: input.sessions,
    messagesBySession: input.messagesBySession ?? {},
    activeSessionId: input.activeSessionId,
  });
}

async function waitForActiveSession(sessionId: string): Promise<void> {
  await waitFor(
    `active session ${sessionId}`,
    () => attr(rowSelector(sessionId), "data-active"),
    (value) => value === "true",
  );
}

describe("V2 PR conversation critical path", () => {
  beforeAll(async () => {
    await launchV2E2EApp();
  });

  beforeEach(async () => {
    await cleanupV2();
  });

  afterAll(async () => {
    await stopV2E2EApp();
  });

  it("V2-PR-01: session list loads seeded conversations", async () => {
    const runId = nextRunId("list");
    const memberId = id(runId, "member-me");
    const agentId = id(runId, "agent-lobster");
    const collaboratorId = id(runId, "member-collab");
    const newestId = id(runId, "session-newest");
    const middleId = id(runId, "session-middle");
    const oldestId = id(runId, "session-oldest");

    await seedConversation({
      runId,
      actors: [
        { id: memberId, actorType: "member", displayName: "你" },
        { id: agentId, actorType: "agent", displayName: "Claw" },
        { id: collaboratorId, actorType: "member", displayName: "林夏" },
      ],
      sessions: [
        {
          id: oldestId,
          title: "旧线索整理",
          lastMessageAt: "2026-05-18T01:00:00.000Z",
          lastMessagePreview: "旧线索 preview",
          participantActorIds: [memberId],
        },
        {
          id: newestId,
          title: "今天关键会话",
          lastMessageAt: "2026-05-18T03:00:00.000Z",
          lastMessagePreview: "最新 preview 需要展示",
          participantActorIds: [memberId, agentId, collaboratorId],
        },
        {
          id: middleId,
          title: "中间会话",
          lastMessageAt: "2026-05-18T02:00:00.000Z",
          lastMessagePreview: "中间 preview",
          participantActorIds: [],
        },
      ],
      activeSessionId: newestId,
    });

    await waitForSelector('[data-testid="v2-session-list-column"]');
    await waitForSelector(rowSelector(newestId));

    await waitFor(
      "session rows ordered by last_message_at desc",
      rowIds,
      (ids) => ids.slice(0, 3).join("|") === [newestId, middleId, oldestId].join("|"),
    );
    await waitForActiveSession(newestId);

    expect(await domText(`${rowSelector(newestId)} [data-testid="v2-session-row-title"]`)).toContain("今天关键会话");
    expect(await domText(`${rowSelector(newestId)} [data-testid="v2-session-row-preview"]`)).toContain("最新 preview 需要展示");
    await waitForText("3 位");
    expect(await domText(`${rowSelector(newestId)} [data-testid="v2-session-row-participants"]`)).toContain("3 位");
    expect(await domCount(`${rowSelector(middleId)} [data-testid="v2-session-row-participants"]`)).toBe(0);
  });

  it("V2-PR-02: create/switch session preserves isolated history", async () => {
    const runId = nextRunId("switch");
    const memberId = id(runId, "member");
    const agentId = id(runId, "agent");
    const sessionA = id(runId, "session-a");
    const sessionB = id(runId, "session-b");

    await seedConversation({
      runId,
      actors: [
        { id: memberId, actorType: "member", displayName: "你" },
        { id: agentId, actorType: "agent", displayName: "Claw" },
      ],
      sessions: [
        {
          id: sessionA,
          title: "会话 A",
          lastMessageAt: "2026-05-18T04:00:00.000Z",
          lastMessagePreview: "A 独有 agent",
          participantActorIds: [memberId, agentId],
        },
        {
          id: sessionB,
          title: "会话 B",
          lastMessageAt: "2026-05-18T03:00:00.000Z",
          lastMessagePreview: "B 独有 agent",
          participantActorIds: [memberId, agentId],
        },
      ],
      messagesBySession: {
        [sessionA]: [
          {
            messageId: id(runId, "a-user"),
            senderActorId: memberId,
            kind: "text",
            content: "A 独有 user message",
            createdAt: "2026-05-18T04:00:01.000Z",
          },
          {
            messageId: id(runId, "a-agent"),
            senderActorId: agentId,
            kind: "agent_reply",
            content: "A 独有 agent reply",
            createdAt: "2026-05-18T04:00:02.000Z",
            model: "e2e-model",
            turnId: id(runId, "a-turn"),
          },
        ],
        [sessionB]: [
          {
            messageId: id(runId, "b-user"),
            senderActorId: memberId,
            kind: "text",
            content: "B 独有 user message",
            createdAt: "2026-05-18T03:00:01.000Z",
          },
          {
            messageId: id(runId, "b-agent"),
            senderActorId: agentId,
            kind: "agent_reply",
            content: "B 独有 agent reply",
            createdAt: "2026-05-18T03:00:02.000Z",
            model: "e2e-model",
            turnId: id(runId, "b-turn"),
          },
        ],
      },
      activeSessionId: sessionA,
    });

    await waitForText("A 独有 user message");
    expect(await domText('[data-testid="v2-message-list"]')).toContain("A 独有 agent reply");
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("B 独有 user message");

    await clickSelector(rowSelector(sessionB));
    await waitForActiveSession(sessionB);
    await waitForText("B 独有 user message");
    expect(await domText('[data-testid="v2-message-list"]')).toContain("B 独有 agent reply");
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("A 独有 user message");

    await v2Call("switchSession", { sessionId: sessionA });
    await waitForActiveSession(sessionA);
    await waitForText("A 独有 agent reply");
    expect(await domText('[data-testid="v2-message-list"]')).toContain("A 独有 user message");
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("B 独有 agent reply");
  });

  it("V2-PR-03: prompt send renders user message and agent streaming lifecycle", async () => {
    const runId = nextRunId("stream");
    const memberId = id(runId, "member");
    const agentId = id(runId, "agent");
    const sessionId = id(runId, "session");
    const userPrompt = "请整理 V2 streaming 生命周期";
    const streamingText = "正在整理 streaming delta";
    const finalText = "最终 persisted agent answer";

    await seedConversation({
      runId,
      actors: [
        { id: memberId, actorType: "member", displayName: "你" },
        { id: agentId, actorType: "agent", displayName: "Claw" },
      ],
      sessions: [
        {
          id: sessionId,
          title: "Streaming 会话",
          lastMessageAt: "2026-05-18T05:00:00.000Z",
          lastMessagePreview: "等待输入",
          participantActorIds: [memberId, agentId],
        },
      ],
      activeSessionId: sessionId,
    });

    await v2Call("appendMessage", {
      sessionId,
      messageId: id(runId, "user-prompt"),
      senderActorId: memberId,
      kind: "text",
      content: userPrompt,
      createdAt: "2026-05-18T05:00:01.000Z",
    });
    await waitForText(userPrompt);

    await v2Call("emitAgentDelta", {
      sessionId,
      actorId: agentId,
      delta: streamingText,
    });
    await waitForSelector(`[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"][data-actor-id="${agentId}"]`);
    await waitForText(streamingText);

    await v2Call("completeRun", {
      sessionId,
      actorId: agentId,
      runId,
      messageId: id(runId, "final-agent"),
      content: finalText,
      model: "e2e-model",
    });

    await waitForText(finalText);
    await waitFor(
      "streaming bubble to clear after completion",
      () => domCount(`[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"]`),
      (count) => count === 0,
    );
    expect(await textOccurrences('[data-testid="v2-message-list"]', finalText)).toBe(1);
    expect(await domText('[data-testid="v2-message-list"]')).toContain(userPrompt);
  });

  it("V2-PR-04: tool call and error surfaces render deterministically", async () => {
    const runId = nextRunId("tools");
    const memberId = id(runId, "member");
    const agentId = id(runId, "agent");
    const sessionId = id(runId, "session");
    const successToolId = id(runId, "tool-success");
    const failedToolId = id(runId, "tool-failed");

    await seedConversation({
      runId,
      actors: [
        { id: memberId, actorType: "member", displayName: "你" },
        { id: agentId, actorType: "agent", displayName: "Claw" },
      ],
      sessions: [
        {
          id: sessionId,
          title: "Tool 会话",
          lastMessageAt: "2026-05-18T06:00:00.000Z",
          lastMessagePreview: "等待 tool",
          participantActorIds: [memberId, agentId],
        },
      ],
      activeSessionId: sessionId,
    });

    await v2Call("startTool", {
      sessionId,
      actorId: agentId,
      toolId: successToolId,
      toolName: "grep",
      description: "查找成功路径",
      params: { query: "critical-path" },
    });
    await waitForSelector(`[data-testid="v2-streaming-tool"][data-tool-id="${successToolId}"][data-tool-status="calling"]`);

    await v2Call("emitAgentDelta", {
      sessionId,
      actorId: agentId,
      channel: "thinking",
      delta: "hidden deterministic thinking",
    });
    await v2Call("setPermissionRequest", {
      sessionId,
      actorId: agentId,
      requestId: id(runId, "permission"),
      toolName: "write_file",
      description: "hidden permission request",
      params: { path: "secret.md" },
    });
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("hidden deterministic thinking");
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("hidden permission request");
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("Awaiting permission");

    await v2Call("completeTool", {
      sessionId,
      actorId: agentId,
      toolId: successToolId,
      success: true,
      summary: "grep 成功结果",
    });
    await waitForSelector(`[data-testid="v2-streaming-tool"][data-tool-id="${successToolId}"][data-tool-status="completed"]`);
    await expandStreamingTool(successToolId);
    await waitForText("grep 成功结果");

    await v2Call("startTool", {
      sessionId,
      actorId: agentId,
      toolId: failedToolId,
      toolName: "bash",
      description: "执行失败路径",
      params: { command: "exit 2" },
    });
    await waitForSelector(`[data-testid="v2-streaming-tool"][data-tool-id="${failedToolId}"][data-tool-status="calling"]`);

    await v2Call("completeTool", {
      sessionId,
      actorId: agentId,
      toolId: failedToolId,
      success: false,
      summary: "bash 失败结果",
    });
    await waitForSelector(`[data-testid="v2-streaming-tool"][data-tool-id="${failedToolId}"][data-tool-status="failed"]`);
    await expandStreamingTool(failedToolId);
    await waitForText("bash 失败结果");

    await v2Call("setAgentError", {
      sessionId,
      actorId: agentId,
      message: "Agent deterministic error",
      details: "stack: deterministic failure",
    });
    await waitForSelector('[data-testid="v2-streaming-error"]');
    await waitForText("Agent deterministic error");
    await waitForText("stack: deterministic failure");

    // A pending permission belongs to the composer's approval panel, never to
    // the thread. It stays there until the daemon reports it resolved
    // (handle-session-event-permission-resolved), which an agent error alone
    // does not simulate — so assert where it renders, not that it is gone.
    expect(await domCount('[data-testid="v2-message-list"] [data-testid="pending-permission-card"]')).toBe(0);
    expect(await domCount('[data-testid="composer-approval-chrome"] [data-testid="pending-permission-card"]')).toBe(1);
    expect(await domText('[data-testid="v2-message-list"]')).not.toContain("Awaiting permission");
  });
});
