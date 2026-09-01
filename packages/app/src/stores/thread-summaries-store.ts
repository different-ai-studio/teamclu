import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { rememberThreadForkMetadata } from "@/lib/thread-fork-metadata";
import {
  sortThreadSummaries,
  type ThreadSummary,
} from "@/lib/thread-summary";

type ParentEntry = {
  summaries: ThreadSummary[];
  loading: boolean;
  loaded: boolean;
};

type ThreadSummariesStore = {
  byParent: Record<string, ParentEntry | undefined>;
  load: (parentSessionId: string, opts?: { force?: boolean }) => Promise<void>;
  invalidate: (parentSessionId: string) => void;
  upsertThreadSummary: (parentSessionId: string, summary: ThreadSummary) => void;
};

const inFlight = new Map<string, Promise<void>>();

export const useThreadSummariesStore = create<ThreadSummariesStore>((set, get) => ({
  byParent: {},

  load: async (parentSessionId, opts) => {
    const trimmed = parentSessionId.trim();
    if (!trimmed) return;

    const force = opts?.force ?? false;
    const current = get().byParent[trimmed];
    if (!force && current?.loaded && !current.loading) {
      return;
    }

    const pending = inFlight.get(trimmed);
    if (pending && !force) {
      await pending;
      return;
    }

    set((state) => ({
      byParent: {
        ...state.byParent,
        [trimmed]: {
          summaries: current?.summaries ?? [],
          loading: true,
          loaded: current?.loaded ?? false,
        },
      },
    }));

    const promise = (async () => {
      try {
        const items = await getBackend().sessions.listThreadSummaries(trimmed);
        const sorted = sortThreadSummaries(items);
        for (const row of sorted) {
          rememberThreadForkMetadata(
            row.threadSessionId,
            trimmed,
            row.rootMessageId,
          );
        }
        set((state) => ({
          byParent: {
            ...state.byParent,
            [trimmed]: {
              summaries: sorted,
              loading: false,
              loaded: true,
            },
          },
        }));
      } catch {
        set((state) => ({
          byParent: {
            ...state.byParent,
            [trimmed]: {
              summaries: [],
              loading: false,
              loaded: true,
            },
          },
        }));
      } finally {
        inFlight.delete(trimmed);
      }
    })();

    inFlight.set(trimmed, promise);
    await promise;
  },

  invalidate: (parentSessionId) => {
    const trimmed = parentSessionId.trim();
    if (!trimmed) return;
    inFlight.delete(trimmed);
    void get().load(trimmed, { force: true });
  },

  upsertThreadSummary: (parentSessionId, summary) => {
    const trimmed = parentSessionId.trim();
    if (!trimmed || !summary.threadSessionId || !summary.rootMessageId) return;
    rememberThreadForkMetadata(
      summary.threadSessionId,
      trimmed,
      summary.rootMessageId,
    );
    set((state) => {
      const current = state.byParent[trimmed]?.summaries ?? [];
      const next = sortThreadSummaries([
        ...current.filter((row) => row.rootMessageId !== summary.rootMessageId),
        summary,
      ]);
      return {
        byParent: {
          ...state.byParent,
          [trimmed]: {
            summaries: next,
            loading: false,
            loaded: true,
          },
        },
      };
    });
  },
}));