import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "./outbox-backoff";
import type { NewOutboxRow, OutboxDao, OutboxRow } from "./outbox-db";

export type OutboxSendFn = (row: OutboxRow) => Promise<void>;

export type OutboxSender = {
  start: () => void;
  stop: () => void;
  enqueue: (row: NewOutboxRow) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
};

type Deps = {
  dao: OutboxDao;
  send: OutboxSendFn;
  onChange: () => void;
  tickMs?: number;
  now?: () => number;
};

export function createOutboxSender(deps: Deps): OutboxSender {
  const tickMs = deps.tickMs ?? 1000;
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function pass() {
    const due = await deps.dao.fetchDue(now());
    for (const row of due) {
      await attempt(row);
    }
  }

  async function attempt(row: OutboxRow) {
    await deps.dao.markInFlight(row.messageId, now());
    deps.onChange();
    try {
      await deps.send(row);
      await deps.dao.markDelivered(row.messageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempt = row.attemptCount + 1;
      if (nextAttempt >= OUTBOX_MAX_ATTEMPTS) {
        await deps.dao.markFailedExhausted(row.messageId, nextAttempt, message);
      } else {
        await deps.dao.markFailedRetry(
          row.messageId,
          nextAttempt,
          now() + outboxBackoffMs(nextAttempt),
          message,
        );
      }
    }
    deps.onChange();
  }

  // One pass at a time: a wake that lands mid-pass asks for another pass
  // instead of starting a second one, which could send the same row twice.
  let passing = false;
  let passRequested = false;

  async function runPass() {
    if (passing) {
      passRequested = true;
      return;
    }
    passing = true;
    try {
      do {
        passRequested = false;
        try {
          await pass();
        } catch {
          // Per-row failures are already recorded on the row (last_error,
          // attempt_count) and retried with backoff. This guard is only so one
          // bad pass can't kill the scheduling loop and strand the whole outbox.
        }
      } while (passRequested && running);
    } finally {
      passing = false;
    }
  }

  // A new or retried row goes out now, not on the next idle tick (iOS P6:
  // waiting for the tick was ~1s of a send's latency).
  function wake() {
    if (running) void runPass();
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(async () => {
      await runPass();
      scheduleNext();
    }, tickMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      scheduleNext();
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    async enqueue(row) {
      await deps.dao.enqueue(row);
      deps.onChange();
      wake();
    },
    async retry(messageId) {
      await deps.dao.retry(messageId);
      deps.onChange();
      wake();
    },
  };
}
