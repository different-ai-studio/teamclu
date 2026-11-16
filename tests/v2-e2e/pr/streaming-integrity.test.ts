import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  launchV2E2EApp,
  stopV2E2EApp,
  cleanupV2,
  v2Call,
  waitForSelector,
  waitForText,
  domCount,
  domText,
} from "../_utils/v2-app";
import { executeJs } from "../../_utils/tauri-mcp-test-utils";

// ── local helpers ────────────────────────────────────────────────────────────
const RUN_PREFIX = `si-${Date.now().toString(36)}`;
let runCounter = 0;
function nextRunId(prefix: string): string {
  runCounter += 1;
  return `${RUN_PREFIX}-${prefix}-${runCounter}`;
}
function id(runId: string, suffix: string): string {
  return `${runId}-${suffix}`;
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error(`waitFor timed out: ${label} (last=${JSON.stringify(last)})`);
}

async function textOccurrences(selector: string, text: string): Promise<number> {
  if (!text) throw new Error("textOccurrences: needle must not be empty");
  const code = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "0";
      const hay = el.textContent || "";
      const needle = ${JSON.stringify(text)};
      if (!needle) return "0";
      let count = 0, idx = 0;
      while ((idx = hay.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
      return String(count);
    })()
  `;
  return Number(await executeJs(code));
}

async function seedSingleAgentSession(opts: {
  runId: string;
  sessionId: string;
  memberId: string;
  agentId: string;
  title: string;
}): Promise<void> {
  await v2Call("seedConversation", {
    runId: opts.runId,
    teamId: `${opts.runId}-team`,
    workspacePath: `/tmp/${opts.runId}-workspace`,
    actors: [
      { id: opts.memberId, actorType: "member", displayName: "你" },
      { id: opts.agentId, actorType: "agent", displayName: "Claw" },
    ],
    sessions: [
      {
        id: opts.sessionId,
        title: opts.title,
        lastMessageAt: new Date().toISOString(),
        lastMessagePreview: "等待输入",
        participantActorIds: [opts.memberId, opts.agentId],
      },
    ],
    activeSessionId: opts.sessionId,
  });
}

async function messageListDistanceFromBottom(): Promise<number> {
  const code = `
    (() => {
      const list = document.querySelector('[data-testid="v2-message-list"]');
      if (!list) return "999999";
      // Walk up from the list element to find the nearest scrollable ancestor.
      // Bounded by <body> to avoid latching onto unrelated page-level scrollers.
      let node = list;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const oy = style.overflowY;
        if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) {
          return String(node.scrollHeight - node.scrollTop - node.clientHeight);
        }
        node = node.parentElement;
      }
      // No dedicated scroll container found inside <body> — list fits in viewport.
      return "0";
    })()
  `;
  const raw = await executeJs(code);
  const n = Number(raw ?? "999999");
  return Number.isNaN(n) ? 999999 : n;
}

describe("V2 PR streaming integrity (spec D8/D9)", () => {
  beforeAll(async () => {
    await launchV2E2EApp();
  });

  beforeEach(async () => {
    await cleanupV2();
  });

  afterAll(async () => {
    await stopV2E2EApp();
  });

  it("V2-D8: multi-delta stream collapses to a single final message on completion", async () => {
    const runId = nextRunId("d8");
    const memberId = id(runId, "member");
    const agentId = id(runId, "agent");
    const sessionId = id(runId, "session");
    const userPrompt = "讲一个一句话故事";
    const deltas = ["从前", "有一只", "会写代码的", "螃蟹。"];
    const streamingText = deltas.join("");
    const finalText = "从前有一只会写代码的螃蟹,它修好了最后一个 bug。";

    await seedSingleAgentSession({ runId, sessionId, memberId, agentId, title: "D8 流式完成" });

    await v2Call("appendMessage", {
      sessionId,
      messageId: id(runId, "user-prompt"),
      senderActorId: memberId,
      kind: "text",
      content: userPrompt,
      createdAt: new Date().toISOString(),
    });
    await waitForText(userPrompt);

    for (const delta of deltas) {
      await v2Call("emitAgentDelta", { sessionId, actorId: agentId, delta });
    }

    // During streaming: exactly one streaming node showing accumulated deltas.
    await waitForSelector(
      `[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"][data-actor-id="${agentId}"]`,
    );
    await waitForText(streamingText);
    expect(
      await domCount(`[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"]`),
    ).toBe(1);

    await v2Call("completeRun", {
      sessionId,
      actorId: agentId,
      runId,
      messageId: id(runId, "final-agent"),
      content: finalText,
      model: "e2e-model",
    });

    // After completion: streaming node clears, final text appears exactly once,
    // transient delta text is gone (single source of truth principle).
    await waitForText(finalText);
    await waitFor(
      "streaming node cleared after completion",
      () => domCount(`[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"]`),
      (count) => count === 0,
    );
    expect(await textOccurrences('[data-testid="v2-message-list"]', finalText)).toBe(1);
    expect(await textOccurrences('[data-testid="v2-message-list"]', streamingText)).toBe(0);
    expect(await domText('[data-testid="v2-message-list"]')).toContain(userPrompt);
  });

  it("V2-D9: long agent reply keeps the message list scrolled to the bottom", async () => {
    const runId = nextRunId("d9");
    const memberId = id(runId, "member");
    const agentId = id(runId, "agent");
    const sessionId = id(runId, "session");

    await seedSingleAgentSession({ runId, sessionId, memberId, agentId, title: "D9 长回复滚动" });

    await v2Call("appendMessage", {
      sessionId,
      messageId: id(runId, "user-prompt"),
      senderActorId: memberId,
      kind: "text",
      content: "写一段很长的说明",
      createdAt: new Date().toISOString(),
    });
    await waitForText("写一段很长的说明");

    const line = "这是一段用于撑高消息列表的较长文本,确保内容超过视口高度。";
    for (let i = 0; i < 80; i++) {
      // Not "79. …": Markdown turns numbered lines into an <ol>, whose markers
      // are not text, so the wait below could never match.
      await v2Call("emitAgentDelta", { sessionId, actorId: agentId, delta: `第${i}行：${line}\n\n` });
    }
    await waitForSelector(
      `[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"][data-actor-id="${agentId}"]`,
    );
    // Wait for the last delta line to be rendered before checking scroll position.
    await waitForText(`第79行：${line}`);

    await waitFor(
      "message list pinned to bottom during long stream",
      () => messageListDistanceFromBottom(),
      (dist) => dist <= 24,
    );
  });
});
