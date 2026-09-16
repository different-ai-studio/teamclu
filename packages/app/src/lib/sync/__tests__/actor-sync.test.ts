import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listActorDirectoryForSync: vi.fn(),
  upsertActorsBatch: vi.fn(async (_rows: unknown[]) => {}),
  loadActorsForTeam: vi.fn(async () => []),
  softDeleteActor: vi.fn(async () => {}),
  getWatermark: vi.fn(async () => null as string | null),
  setWatermark: vi.fn(async () => {}),
  notifyActorDirectorySynced: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({ isTauri: mocks.isTauri }));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sync: { listActorDirectoryForSync: mocks.listActorDirectoryForSync },
  }),
}));

vi.mock("@/lib/cache/local-cache", () => ({
  upsertActorsBatch: mocks.upsertActorsBatch,
  loadActorsForTeam: mocks.loadActorsForTeam,
  softDeleteActor: mocks.softDeleteActor,
  getWatermark: mocks.getWatermark,
  setWatermark: mocks.setWatermark,
}));

vi.mock("@/stores/actor-directory-store", () => ({
  notifyActorDirectorySynced: mocks.notifyActorDirectorySynced,
}));

import { syncActorsForTeam } from "@/lib/sync/actor-sync";

function serverRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    team_id: "team-1",
    actor_type: "member",
    display_name: id,
    member_status: "active",
    agent_status: null,
    last_active_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...extra,
  };
}

describe("syncActorsForTeam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri.mockReturnValue(true);
  });

  // The cache row is upserted whole, so a null here used to blank the photo
  // the directory had cached for the next cold start.
  it("writes each actor's avatar into the local cache", async () => {
    mocks.listActorDirectoryForSync.mockResolvedValue([
      serverRow("with-photo", { avatar_url: "https://cdn.example.test/avatars/with-photo/a.jpg" }),
      serverRow("no-photo", { avatar_url: null }),
    ]);

    await syncActorsForTeam("team-1");

    const rows = mocks.upsertActorsBatch.mock.calls[0][0] as Array<{ id: string; avatarUrl: string | null }>;
    expect(rows.map((r) => [r.id, r.avatarUrl])).toEqual([
      ["with-photo", "https://cdn.example.test/avatars/with-photo/a.jpg"],
      ["no-photo", null],
    ]);
  });

  it("treats a Cloud API that does not send avatar_url yet as no photo", async () => {
    mocks.listActorDirectoryForSync.mockResolvedValue([serverRow("older-api")]);

    await syncActorsForTeam("team-1");

    const rows = mocks.upsertActorsBatch.mock.calls[0][0] as Array<{ avatarUrl: string | null }>;
    expect(rows[0].avatarUrl).toBeNull();
  });
});
