import {
  executeJs,
  focusWindow,
  isReusingExistingApp,
  launchTeamCluApp,
  sleep,
  stopApp,
} from "../../_utils/tauri-mcp-test-utils";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

type V2CallSlot =
  | { status: "pending" }
  | { status: "resolved"; value: string }
  | { status: "rejected"; error: string }
  | { status: "cancelled" };

async function jsJson<T>(code: string): Promise<T> {
  const raw = await executeJs(code);
  return JSON.parse(raw) as T;
}

async function waitFor<T>(
  description: string,
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
    await sleep(POLL_INTERVAL_MS);
  }

  const details = lastError instanceof Error
    ? lastError.message
    : JSON.stringify(lastValue);
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}: ${details}`);
}

export async function launchV2E2EApp(): Promise<string> {
  const processId = await launchTeamCluApp();
  if (isReusingExistingApp() && !(await hasV2ControlSurface())) {
    throw new Error(
      [
        "Refusing to run V2 E2E against an existing non-E2E TeamClu app.",
        "Stop the running app, then rerun with a binary built using VITE_TEAMCLU_E2E=true.",
      ].join(" "),
    );
  }
  await focusWindow();
  await waitForSelectorReady();
  return processId;
}

export async function stopV2E2EApp(): Promise<void> {
  let cleanupError: unknown;
  try {
    await cleanupV2();
  } catch (error) {
    cleanupError = error;
  }

  try {
    await stopApp();
  } catch (stopError) {
    if (cleanupError) {
      throw new AggregateError([cleanupError, stopError], "cleanupV2 and stopApp both failed");
    }
    throw stopError;
  }

  if (cleanupError) throw cleanupError;
}

export async function v2Call<T = unknown>(method: string, args?: unknown): Promise<T> {
  const callId = `v2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const argsCode = args === undefined ? "undefined" : JSON.stringify(args);

  await jsJson<{ started: true }>(`
    (() => {
      const callId = ${JSON.stringify(callId)};
      const calls = window.__TEAMCLU_V2_E2E_CALLS__ ||= {};
      const setRejected = (error) => {
        if (calls[callId]?.status !== "pending") return;
        calls[callId] = {
          status: "rejected",
          error: error instanceof Error ? error.message : String(error),
        };
      };

      calls[callId] = { status: "pending" };

      try {
        const api = window.__TEAMCLU_V2_E2E__;
        if (!api) throw new Error("window.__TEAMCLU_V2_E2E__ is not installed");

        const fn = api[${JSON.stringify(method)}];
        if (typeof fn !== "function") {
          throw new Error("window.__TEAMCLU_V2_E2E__." + ${JSON.stringify(method)} + " is not a function");
        }

        Promise.resolve()
          .then(() => fn(${argsCode}))
          .then((result) => {
            if (calls[callId]?.status !== "pending") return;
            calls[callId] = {
              status: "resolved",
              value: JSON.stringify(
                result ?? null,
                (_key, value) => typeof value === "bigint" ? value.toString() : value,
              ),
            };
          })
          .catch(setRejected);
      } catch (error) {
        setRejected(error);
      }

      return JSON.stringify({ started: true });
    })()
  `);

  try {
    const slot = await waitFor(
      `V2 E2E control call ${method}`,
      () => readV2CallSlot(callId),
      (value) => value?.status === "resolved" || value?.status === "rejected",
      DEFAULT_TIMEOUT_MS,
    );

    if (slot?.status === "rejected") {
      throw new Error(slot.error);
    }

    if (slot?.status !== "resolved") {
      throw new Error(`V2 E2E control call ${method} finished without a result`);
    }

    return JSON.parse(slot.value) as T;
  } finally {
    await cancelV2CallSlot(callId);
    await clearV2CallSlot(callId);
  }
}

export async function cleanupV2(): Promise<void> {
  if (!(await hasV2ControlSurface())) return;
  await v2Call("cleanup");
}

export async function domText(selector: string): Promise<string> {
  return jsJson<string>(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return JSON.stringify(el?.textContent ?? "");
    })()
  `);
}

export async function domCount(selector: string): Promise<number> {
  return jsJson<number>(`
    (() => JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length))()
  `);
}

export async function waitForText(text: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await waitFor(
    `text ${JSON.stringify(text)}`,
    () => domText("body"),
    (bodyText) => bodyText.includes(text),
    timeoutMs,
  );
}

export async function waitForSelector(
  selector: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await waitFor(
    `selector ${JSON.stringify(selector)}`,
    () => domCount(selector),
    (count) => count > 0,
    timeoutMs,
  );
}

/**
 * Open a streaming tool row so its result is in the DOM. Tool rows are
 * collapsible and render their result only while open (Radix unmounts closed
 * content), so a test that waits for a tool's summary must open it first.
 * Idempotent: an open row is left alone, so a re-run of the script cannot
 * toggle it shut again.
 */
export async function expandStreamingTool(toolId: string): Promise<void> {
  const root = `[data-testid="v2-streaming-tool"][data-tool-id="${toolId}"]`;
  await jsJson<{ state: string }>(`
    (() => {
      const root = document.querySelector(${JSON.stringify(root)});
      if (!root) throw new Error("No streaming tool " + ${JSON.stringify(toolId)});
      const box = root.querySelector('[data-slot="collapsible"]');
      if (box && box.getAttribute("data-state") === "open") return JSON.stringify({ state: "open" });
      // tool-row-* (most tools) and tool-card-* (bash) share the trigger shape.
      const trigger = root.querySelector('[data-slot="collapsible"] [type="button"]');
      if (!trigger) throw new Error("No expand trigger for tool " + ${JSON.stringify(toolId)});
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window }));
      return JSON.stringify({ state: box ? box.getAttribute("data-state") : "unknown" });
    })()
  `);
}

export async function clickSelector(selector: string): Promise<void> {
  await jsJson<{ clicked: true }>(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("No element found for selector: " + ${JSON.stringify(selector)});

      let clicked = false;
      el.addEventListener("click", () => { clicked = true; }, { capture: true, once: true });
      el.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));

      if (!clicked) throw new Error("Click listener did not fire for selector: " + ${JSON.stringify(selector)});
      return JSON.stringify({ clicked });
    })()
  `);
}

export async function setComposerText(text: string): Promise<void> {
  await jsJson<{ ok: true }>(`
    (() => {
      const editor =
        document.querySelector('[data-testid="v2-composer-editor"]') ||
        document.querySelector('[contenteditable="true"]');
      if (!editor) throw new Error("Composer editor not found");

      editor.textContent = ${JSON.stringify(text)};
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: ${JSON.stringify(text)},
      }));
      return JSON.stringify({ ok: true });
    })()
  `);
}

export async function submitComposer(): Promise<void> {
  await jsJson<{ clicked: true }>(`
    (() => {
      const root = document.querySelector('[data-testid="chat-input-area"]');
      if (!root) throw new Error("Chat input area not found");

      const submitRoot = root.querySelector('[data-onboarding-id="chat-input-submit"]');
      if (!submitRoot) throw new Error("Composer submit control cluster not found");

      const buttons = Array.from(submitRoot.querySelectorAll('button:not([disabled])'));
      const button = buttons.find((candidate) => {
        const ariaLabel = candidate.getAttribute("aria-label") || "";
        const text = candidate.textContent || "";
        const type = candidate.getAttribute("type") || "";
        return (
          type === "submit" ||
          /send|submit|发送/i.test(ariaLabel) ||
          /send|submit|发送/i.test(text)
        );
      });

      if (!button) {
        const disabledSubmit = submitRoot.querySelector('button[type="submit"][disabled]');
        if (disabledSubmit) throw new Error("Composer submit button is disabled");
        throw new Error("Composer submit button not found");
      }

      let clicked = false;
      button.addEventListener("click", () => { clicked = true; }, { capture: true, once: true });
      button.click();

      if (!clicked) throw new Error("Composer submit click listener did not fire");
      return JSON.stringify({ clicked });
    })()
  `);
}

async function waitForSelectorReady(): Promise<void> {
  try {
    await waitFor(
      "window.__TEAMCLU_V2_E2E__",
      () => jsJson<boolean>(`
        (() => JSON.stringify(Boolean(window.__TEAMCLU_V2_E2E__)))()
      `),
      Boolean,
      DEFAULT_TIMEOUT_MS,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        "V2 E2E control surface is not installed.",
        "The app connected through the Tauri MCP socket must be built with VITE_TEAMCLU_E2E=true.",
        "If a normal TeamClu app is already running, stop it before running the V2 E2E suite so the launcher does not reuse that non-E2E socket.",
        `Original wait failure: ${detail}`,
      ].join(" "),
    );
  }
}

async function readV2CallSlot(callId: string): Promise<V2CallSlot | null> {
  return jsJson<V2CallSlot | null>(`
    (() => {
      const slot = window.__TEAMCLU_V2_E2E_CALLS__?.[${JSON.stringify(callId)}] ?? null;
      return JSON.stringify(slot);
    })()
  `);
}

async function cancelV2CallSlot(callId: string): Promise<void> {
  try {
    await executeJs(`
      (() => {
        if (window.__TEAMCLU_V2_E2E_CALLS__?.[${JSON.stringify(callId)}]?.status === "pending") {
          window.__TEAMCLU_V2_E2E_CALLS__[${JSON.stringify(callId)}] = { status: "cancelled" };
        }
        return "null";
      })()
    `);
  } catch {
    // The app may already be gone during test teardown.
  }
}

async function clearV2CallSlot(callId: string): Promise<void> {
  try {
    await executeJs(`
      (() => {
        if (window.__TEAMCLU_V2_E2E_CALLS__) {
          delete window.__TEAMCLU_V2_E2E_CALLS__[${JSON.stringify(callId)}];
        }
        return "null";
      })()
    `);
  } catch {
    // The app may already be gone during test teardown.
  }
}

async function hasV2ControlSurface(): Promise<boolean> {
  try {
    return (await executeJs("String(Boolean(window.__TEAMCLU_V2_E2E__))")) === "true";
  } catch (error) {
    if (isExecuteJsUnavailableError(error)) return false;
    throw error;
  }
}

function isExecuteJsUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Failed to connect to socket") ||
    error.message.includes("Socket error") ||
    error.message.includes("Socket call 'execute_js' timed out") ||
    error.message.includes("Socket closed without valid response")
  );
}
