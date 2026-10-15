import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../features/sessions/session-types";

type SessionsApi = {
  listSessions: (teamId: string) => Promise<SessionSummary[]>;
};

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createSession(id: string, lastMessageAt: string, createdAt: string): SessionSummary {
  return {
    sessionId: id,
    teamId: "team-1",
    title: `Session ${id}`,
    summary: `Summary ${id}`,
    participantCount: 1,
    participantActorIds: ["actor-1"],
    lastMessagePreview: `Preview ${id}`,
    lastMessageAt,
    createdAt,
    createdBy: "actor-1",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionsController", () => {
  it("loads sessions into the loaded state and groups them by recency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

    const { createSessionsController } = await import("../features/sessions/session-controller");
    const api: SessionsApi = {
      listSessions: vi.fn().mockResolvedValue([
        createSession(
          "session-1",
          new Date(2026, 4, 18, 11, 0, 0).toISOString(),
          new Date(2026, 4, 17, 11, 0, 0).toISOString(),
        ),
        createSession(
          "session-2",
          new Date(2026, 4, 17, 11, 0, 0).toISOString(),
          new Date(2026, 4, 16, 11, 0, 0).toISOString(),
        ),
      ]),
    };

    const controller = createSessionsController(api as any, "team-1");

    await expect(controller.load()).resolves.toBeUndefined();

    expect(api.listSessions).toHaveBeenCalledWith("team-1", undefined);
    expect(controller.getState()).toMatchObject({
      status: "loaded",
      isLoading: false,
      isRefreshing: false,
      errorMessage: null,
      sessions: [
        expect.objectContaining({ sessionId: "session-1" }),
        expect.objectContaining({ sessionId: "session-2" }),
      ],
      groups: [
        {
          label: "Today",
          sessions: [expect.objectContaining({ sessionId: "session-1" })],
        },
        {
          label: "Yesterday",
          sessions: [expect.objectContaining({ sessionId: "session-2" })],
        },
      ],
    });
  });

  it("enters the empty state when the API returns no sessions", async () => {
    const { createSessionsController } = await import("../features/sessions/session-controller");
    const api: SessionsApi = {
      listSessions: vi.fn().mockResolvedValue([]),
    };

    const controller = createSessionsController(api as any, "team-1");

    await controller.load();

    expect(controller.getState()).toMatchObject({
      status: "empty",
      isLoading: false,
      isRefreshing: false,
      errorMessage: null,
      sessions: [],
      groups: [],
    });
  });

  it("stores an error state when loading fails", async () => {
    const { createSessionsController } = await import("../features/sessions/session-controller");
    const api: SessionsApi = {
      listSessions: vi.fn().mockRejectedValue(new Error("network down")),
    };

    const controller = createSessionsController(api as any, "team-1");

    await expect(controller.load()).resolves.toBeUndefined();

    expect(controller.getState()).toMatchObject({
      status: "error",
      isLoading: false,
      isRefreshing: false,
      errorMessage: "network down",
      sessions: [],
      groups: [],
    });
  });

  it("treats refresh with no existing rows as a loading state", async () => {
    const { createSessionsController } = await import("../features/sessions/session-controller");
    const deferredRefresh = createDeferredPromise<SessionSummary[]>();
    const api: SessionsApi = {
      listSessions: vi.fn().mockReturnValue(deferredRefresh.promise),
    };

    const controller = createSessionsController(api as any, "team-1");
    const refreshPromise = controller.refresh();

    expect(controller.getState()).toMatchObject({
      status: "loading",
      isLoading: true,
      isRefreshing: false,
      sessions: [],
      groups: [],
    });

    deferredRefresh.resolve([]);
    await refreshPromise;
  });

  it("a quiet refresh over loaded rows never enters the refreshing state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

    const { createSessionsController } = await import("../features/sessions/session-controller");
    const rows = [
      createSession(
        "session-1",
        new Date(2026, 4, 18, 11, 0, 0).toISOString(),
        new Date(2026, 4, 17, 11, 0, 0).toISOString(),
      ),
    ];
    const deferredRefresh = createDeferredPromise<SessionSummary[]>();
    const api: SessionsApi = {
      listSessions: vi.fn().mockResolvedValueOnce(rows).mockReturnValueOnce(deferredRefresh.promise),
    };
    const controller = createSessionsController(api as any, "team-1");
    await controller.load();
    const seen: boolean[] = [];
    controller.subscribe(() => seen.push(controller.getState().isRefreshing));

    const refreshPromise = controller.refresh({ quiet: true });
    expect(controller.getState()).toMatchObject({ status: "loaded", isRefreshing: false });
    deferredRefresh.resolve(rows);
    await refreshPromise;

    expect(seen).not.toContain(true);
    expect(controller.getState().status).toBe("loaded");
  });

  it("keeps the last loaded rows visible while refresh is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

    const { createSessionsController } = await import("../features/sessions/session-controller");
    const initialRows = [
      createSession(
        "session-1",
        new Date(2026, 4, 18, 11, 0, 0).toISOString(),
        new Date(2026, 4, 17, 11, 0, 0).toISOString(),
      ),
    ];
    const refreshedRows = [
      createSession(
        "session-2",
        new Date(2026, 4, 18, 11, 30, 0).toISOString(),
        new Date(2026, 4, 17, 11, 30, 0).toISOString(),
      ),
    ];
    const deferredRefresh = createDeferredPromise<SessionSummary[]>();
    const api: SessionsApi = {
      listSessions: vi
        .fn()
        .mockResolvedValueOnce(initialRows)
        .mockReturnValueOnce(deferredRefresh.promise),
    };

    const controller = createSessionsController(api as any, "team-1");

    await controller.load();
    const refreshPromise = controller.refresh();

    expect(controller.getState()).toMatchObject({
      status: "refreshing",
      isLoading: false,
      isRefreshing: true,
      errorMessage: null,
      sessions: initialRows,
      groups: [
        {
          label: "Today",
          sessions: initialRows,
        },
      ],
    });

    deferredRefresh.resolve(refreshedRows);
    await refreshPromise;

    expect(controller.getState()).toMatchObject({
      status: "loaded",
      isLoading: false,
      isRefreshing: false,
      errorMessage: null,
      sessions: refreshedRows,
      groups: [
        {
          label: "Today",
          sessions: refreshedRows,
        },
      ],
    });
  });

  it("ignores stale results when a newer request finishes later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

    const { createSessionsController } = await import("../features/sessions/session-controller");
    const slowLoad = createDeferredPromise<SessionSummary[]>();
    const fastRefresh = createDeferredPromise<SessionSummary[]>();
    const api: SessionsApi = {
      listSessions: vi
        .fn()
        .mockReturnValueOnce(slowLoad.promise)
        .mockReturnValueOnce(fastRefresh.promise),
    };

    const controller = createSessionsController(api as any, "team-1");

    const loadPromise = controller.load();
    const refreshPromise = controller.refresh();

    fastRefresh.resolve([
      createSession(
        "session-new",
        new Date(2026, 4, 18, 11, 45, 0).toISOString(),
        new Date(2026, 4, 17, 11, 45, 0).toISOString(),
      ),
    ]);
    await refreshPromise;

    slowLoad.resolve([
      createSession(
        "session-old",
        new Date(2026, 4, 18, 10, 45, 0).toISOString(),
        new Date(2026, 4, 17, 10, 45, 0).toISOString(),
      ),
    ]);
    await loadPromise;

    expect(controller.getState()).toMatchObject({
      status: "loaded",
      sessions: [expect.objectContaining({ sessionId: "session-new" })],
      groups: [
        {
          label: "Today",
          sessions: [expect.objectContaining({ sessionId: "session-new" })],
        },
      ],
    });
  });

  it("notifies subscribers when list state changes", async () => {
    const { createSessionsController } = await import("../features/sessions/session-controller");
    const api: SessionsApi = {
      listSessions: vi.fn().mockResolvedValue([
        createSession(
          "session-1",
          new Date(2026, 4, 18, 11, 0, 0).toISOString(),
          new Date(2026, 4, 17, 11, 0, 0).toISOString(),
        ),
      ]),
    };
    const controller = createSessionsController(api as any, "team-1");
    const listener = vi.fn();

    const unsubscribe = controller.subscribe(listener);
    await controller.load();
    await controller.refresh();
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(4);
  });

  describe("cache hydration", () => {
    it("hydrates rows from cache before the network responds", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

      const { createSessionsController } = await import("../features/sessions/session-controller");
      const cached = [
        createSession(
          "cached-1",
          new Date(2026, 4, 18, 10, 0, 0).toISOString(),
          new Date(2026, 4, 17, 10, 0, 0).toISOString(),
        ),
      ];
      const deferredLoad = createDeferredPromise<SessionSummary[]>();
      const api: SessionsApi = {
        listSessions: vi.fn().mockReturnValue(deferredLoad.promise),
      };
      const cache = {
        load: vi.fn().mockResolvedValue(cached),
        save: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };

      const controller = createSessionsController(api as any, "team-1", null, cache);
      const loadPromise = controller.load();

      // Flush the cache.load microtasks so hydration applies.
      await vi.waitFor(() => {
        expect(controller.getState().sessions).toHaveLength(1);
      });
      expect(controller.getState()).toMatchObject({
        status: "loaded",
        sessions: cached,
      });

      const fresh = [
        createSession(
          "fresh-1",
          new Date(2026, 4, 18, 11, 0, 0).toISOString(),
          new Date(2026, 4, 17, 11, 0, 0).toISOString(),
        ),
      ];
      deferredLoad.resolve(fresh);
      await loadPromise;

      expect(controller.getState().sessions).toEqual(fresh);
      expect(cache.save).toHaveBeenCalledWith("team-1", fresh);
    });

    it("keeps cached rows visible when the network load fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

      const { createSessionsController } = await import("../features/sessions/session-controller");
      const cached = [
        createSession(
          "cached-1",
          new Date(2026, 4, 18, 10, 0, 0).toISOString(),
          new Date(2026, 4, 17, 10, 0, 0).toISOString(),
        ),
      ];
      const api: SessionsApi = {
        listSessions: vi.fn().mockRejectedValue(new Error("offline")),
      };
      const cache = {
        load: vi.fn().mockResolvedValue(cached),
        save: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };

      const controller = createSessionsController(api as any, "team-1", null, cache);
      await controller.load();

      expect(controller.getState()).toMatchObject({
        status: "error",
        errorMessage: "offline",
        sessions: cached,
      });
    });

    it("saves to cache after a successful refresh", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

      const { createSessionsController } = await import("../features/sessions/session-controller");
      const fresh = [
        createSession(
          "fresh-1",
          new Date(2026, 4, 18, 11, 0, 0).toISOString(),
          new Date(2026, 4, 17, 11, 0, 0).toISOString(),
        ),
      ];
      const api: SessionsApi = {
        listSessions: vi.fn().mockResolvedValue(fresh),
      };
      const cache = {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };

      const controller = createSessionsController(api as any, "team-1", null, cache);
      await controller.load();
      await controller.refresh();

      // load() saves once, refresh() saves once more.
      expect(cache.save).toHaveBeenCalledTimes(2);
      expect(cache.save).toHaveBeenLastCalledWith("team-1", fresh);
    });
  });
});
