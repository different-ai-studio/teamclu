# Beta P0 Automation — Phase 1 (v2-e2e streaming gaps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic v2-e2e coverage for the two streaming-chat gaps NOT already covered by `tests/v2-e2e/pr/conversation-critical-path.test.ts` — long-reply autoscroll (spec D9) and multi-delta streaming→completed integrity (spec D8) — establishing the pattern for filling the remaining gaps in later phases.

**Architecture:** New PR-gate test file `tests/v2-e2e/pr/streaming-integrity.test.ts` driving the app through the `window.__TEAMCLU_V2_E2E__` control surface via `v2Call`, mirroring the existing `conversation-critical-path.test.ts` structure. Pure deterministic seed + delta injection; no daemon/FC/network. Assertions read the live DOM via `domCount`/`domText`/`executeJs` against the documented `data-testid` selector contracts.

**Tech Stack:** vitest (`vitest.config.v2-e2e.ts`), tauri-mcp Unix-socket harness, the debug desktop binary built with `VITE_TEAMCLU_E2E=true`.

**Scope note — already covered, do NOT duplicate:** V2-PR-01..04 already cover C1/C2/C3, D2, D4, D7 and PR-03 already asserts post-`completeRun` `textOccurrences(messageList, finalText) === 1`. This plan adds only D9 and a stronger multi-delta D8. Deferred to later phases (need permission-UI / persistence / ACP reading first): E2 approve/deny interaction, C5 delete/archive, A4 restart-restore, D3 interrupt, D5 restart-restore, D6 queue, D10 endurance, and all FC/daemon/Windows suites.

---

### Task 0: Build the E2E debug binary (prerequisite)

**Files:** none (build only)

- [ ] **Step 1: Build the debug app with the E2E control surface**

The v2-e2e harness launches `<repo-root>/.cargo-target/debug/teamclu` and requires `window.__TEAMCLU_V2_E2E__`, which is only installed when built with `VITE_TEAMCLU_E2E=true`.

Run (from the worktree root):
```bash
VITE_TEAMCLU_E2E=true pnpm tauri:build:debug
```
Expected: build completes; `.cargo-target/debug/teamclu` exists and is newer than before.

`scripts/tauri-cli.js` gives an E2E build `app.security.devCsp` (see `scripts/lib/e2e-csp.js`): the production CSP forbids `'unsafe-eval'`, and the harness's `execute_js` evaluates strings, so without it every call fails with an EvalError.

To run beside a developer's own `tauri dev` (which holds `/tmp/tauri-mcp.sock`), start the E2E binary with `TAURI_MCP_SOCKET=/tmp/<other>.sock` and run the suite with the same variable. A debug build writes `<socket>.pid` beside the socket; the harness reads it to know which process it is driving and never kills or raises any other TeamClu window.

- [ ] **Step 2: Sanity-check the existing PR suite is green on this build**

Run:
```bash
pnpm test:e2e:v2:pr
```
Expected: `tests/v2-e2e/pr/conversation-critical-path.test.ts` passes (V2-PR-01..04). If it fails to launch, the binary lacks the E2E surface — rebuild with Step 1. This confirms the harness works before we add tests.

---

### Task 1: New test file scaffold + local helpers

**Files:**
- Create: `tests/v2-e2e/pr/streaming-integrity.test.ts`

- [ ] **Step 1: Create the file with imports, suite skeleton, and local helpers**

```ts
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

// ── local helpers (mirrors conversation-critical-path.test.ts) ──────────────
let runCounter = 0;
function nextRunId(prefix: string): string {
  runCounter += 1;
  return `si-${prefix}-${runCounter}`;
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
): Promise<void> {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeoutMs) {
    last = await read();
    if (predicate(last)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out: ${label} (last=${JSON.stringify(last!)})`);
}

// Count non-overlapping occurrences of `text` inside the element matched by `selector`.
async function textOccurrences(selector: string, text: string): Promise<number> {
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
        lastMessageAt: "2026-06-02T00:00:00.000Z",
        lastMessagePreview: "等待输入",
        participantActorIds: [opts.memberId, opts.agentId],
      },
    ],
    activeSessionId: opts.sessionId,
  });
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

  // tests added in Task 2 and Task 3
});
```

- [ ] **Step 2: Verify the empty suite loads (no tests yet → passes with the existing PR set)**

Run:
```bash
pnpm test:e2e:v2:pr
```
Expected: PASS (new file has no `it()` yet; `passWithNoTests` + existing suite still green). Confirms imports resolve.

- [ ] **Step 3: Commit**

```bash
git add tests/v2-e2e/pr/streaming-integrity.test.ts
git commit -m "test(v2-e2e): scaffold streaming-integrity suite (D8/D9 helpers)"
```

---

### Task 2: D8 — multi-delta streaming → completed handoff integrity

**Files:**
- Modify: `tests/v2-e2e/pr/streaming-integrity.test.ts` (add the `it` inside the describe from Task 1)

This extends PR-03 (which uses a single delta with different streaming/final text) by accumulating MULTIPLE deltas and asserting that after completion the transient delta text is gone, the streaming node clears, and the final text appears exactly once (no duplicate, no leftover streaming buffer).

- [ ] **Step 1: Write the failing test**

```ts
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
      createdAt: "2026-06-02T00:00:01.000Z",
    });
    await waitForText(userPrompt);

    for (const delta of deltas) {
      await v2Call("emitAgentDelta", { sessionId, actorId: agentId, delta });
    }

    // During streaming: a single streaming node shows the accumulated delta text.
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
    // and the transient accumulated delta text is no longer present (no dup/leftover).
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
```

- [ ] **Step 2: Run the test to verify it passes (behavior already correct ⇒ characterization)**

Run:
```bash
pnpm test:e2e:v2:pr -t "V2-D8"
```
Expected: PASS if the streaming→completed handoff is correct. If `textOccurrences(streamingText) !== 0` or final count `!== 1`, that is a real single-source-of-truth bug (transient delta text leaked into the completed message) — STOP and investigate `streamingContent` vs `message.parts[]` handling rather than weakening the assertion.

- [ ] **Step 3: Commit**

```bash
git add tests/v2-e2e/pr/streaming-integrity.test.ts
git commit -m "test(v2-e2e): D8 multi-delta streaming→completed integrity"
```

---

### Task 3: D9 — long agent reply autoscrolls the message list to the bottom

**Files:**
- Modify: `tests/v2-e2e/pr/streaming-integrity.test.ts` (add the `it` inside the describe)

Asserts that when a long agent reply streams in, the message list's scrollable container is pinned to the bottom (within tolerance). Uses `executeJs` to find the nearest scrollable ancestor of `[data-testid="v2-message-list"]` and compare `scrollTop + clientHeight` to `scrollHeight`.

- [ ] **Step 1: Add a scroll-position helper above the `describe` (after `textOccurrences`)**

```ts
// Distance (px) from the bottom of the message-list scroll container. ~0 means pinned to bottom.
async function messageListDistanceFromBottom(): Promise<number> {
  const code = `
    (() => {
      let el = document.querySelector('[data-testid="v2-message-list"]');
      if (!el) return "999999";
      // Walk up to the nearest vertically-scrollable ancestor (incl. el itself).
      let node = el;
      while (node) {
        const style = window.getComputedStyle(node);
        const oy = style.overflowY;
        if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) {
          return String(node.scrollHeight - node.scrollTop - node.clientHeight);
        }
        node = node.parentElement;
      }
      // No scrollable ancestor (content fits) ⇒ trivially "at bottom".
      return "0";
    })()
  `;
  return Number(await executeJs(code));
}
```

- [ ] **Step 2: Write the failing test**

```ts
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
      createdAt: "2026-06-02T00:00:01.000Z",
    });
    await waitForText("写一段很长的说明");

    // Stream enough lines to overflow the viewport.
    const line = "这是一段用于撑高消息列表的较长文本,确保内容超过视口高度。";
    for (let i = 0; i < 40; i++) {
      await v2Call("emitAgentDelta", { sessionId, actorId: agentId, delta: `${i}. ${line}\n` });
    }
    await waitForSelector(
      `[data-testid="v2-streaming-agent"][data-session-id="${sessionId}"][data-actor-id="${agentId}"]`,
    );

    // The list should auto-follow to the bottom while streaming (allow small tolerance).
    await waitFor(
      "message list pinned to bottom during long stream",
      () => messageListDistanceFromBottom(),
      (dist) => dist <= 24,
    );
  });
```

- [ ] **Step 3: Run the test**

Run:
```bash
pnpm test:e2e:v2:pr -t "V2-D9"
```
Expected: PASS if autoscroll-to-bottom works. If it times out with a large distance, autoscroll is broken for long streams (a real D9 defect) — record it; do not relax the tolerance to force green.

- [ ] **Step 4: Run the whole PR suite to confirm no regressions**

Run:
```bash
pnpm test:e2e:v2:pr
```
Expected: all of V2-PR-01..04, V2-D8, V2-D9 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/v2-e2e/pr/streaming-integrity.test.ts
git commit -m "test(v2-e2e): D9 long-reply autoscroll-to-bottom"
```

---

## Deferred to later phases (not in this plan)

- **Phase 2 (permission interaction):** E2 approve/deny — needs the `pending-permission-card` button selectors + outcome wiring read from the permission UI; `setPermissionRequest` already renders the card (PR-04 asserts count only).
- **Phase 3 (FC auth):** B3 invalid/expired OTP and B5 `/v1/auth/refresh` (401 → refresh, no logout) — `services/fc/test` (node:test) + the frontend `cloud-api/http.ts` refresh-retry unit test. (B1 backend round-trip already covered in `auth-pg.test.ts`.)
- **Phase 4 (session ops):** C4 spotlight switch (sendKeys), C5 delete/archive (UI selector + control/store check), A4 restart-restore.
- **Phase 5 (endurance/robustness):** D3 interrupt (ACP cancel), D5 restart-restore, D6 queue, D10 long-session perf (extend `tests/performance/`).
- **Phase 6 (Windows automation enablement):** switch tauri-mcp transport to TCP (plugin already supports `SocketType::Tcp`; only the Node `socketCall` + a build-time env gate + a Windows CI runner are needed), then re-run A/C/E/F + the above on the Windows matrix.

## Self-review notes

- **Spec coverage:** This plan implements D9 (uncovered) and a stronger D8 (extends PR-03). All other spec rows are explicitly listed under "Deferred" with their blocking dependency — no silent gaps.
- **Placeholders:** none — every step has the exact command, expected output, and complete code. Helper bodies (`waitFor`, `textOccurrences`, `messageListDistanceFromBottom`, `seedSingleAgentSession`) are fully defined.
- **Type/name consistency:** control-method arg shapes (`seedConversation`/`appendMessage`/`emitAgentDelta`/`completeRun`) match `packages/app/src/lib/e2e/v2-control.ts`; selectors (`v2-streaming-agent`, `v2-message-list`) and helper names match `tests/v2-e2e/pr/conversation-critical-path.test.ts`.
