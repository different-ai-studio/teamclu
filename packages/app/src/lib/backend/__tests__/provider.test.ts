import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neutralize any baked cloudApiUrl from a local build.config.local.json so the
// committed-state resolution logic is tested deterministically (the production
// default lives in a tracked build config, not the gitignored local file).
vi.mock("@/lib/config/build-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/build-config")>();
  return { ...actual, buildConfig: { ...actual.buildConfig, cloudApiUrl: undefined } };
});

vi.mock("@/lib/backend/cloud-api", () => ({
  hasCloudApiBackendConfig: (config: { cloudApiUrl?: string }) =>
    Boolean(config.cloudApiUrl),
  createCloudApiBackend: () => ({
    kind: "cloud_api",
    auth: {},
    directory: {},
    sessions: {
      listCurrentActorSessions: () => Promise.resolve({ rows: [] }),
    },
    messages: {},
    runtime: {},
    attachments: {},
    teams: {},
    ideas: {},
    actors: {},
    sessionMembers: {},
    shortcuts: {},
    notifications: {},
    teamWorkspaceConfig: {},
    workspaces: {},
    sync: {},
    telemetry: {},
  }),
}));

describe("backend provider facade", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a singleton Cloud API backend", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://cloud.ucar.cc");

    const { getBackend, getBackendKind } = await import("@/lib/backend/provider");

    const first = getBackend();
    const second = getBackend();

    expect(first).toBe(second);
    expect(first.kind).toBe("cloud_api");
    expect(getBackendKind()).toBe("cloud_api");
  });

  it("hasBackendConfig reflects whether a cloudApiUrl resolves", async () => {
    // No env override + no baked default (build config mocked) -> not configured.
    const { hasBackendConfig } = await import("@/lib/backend/provider");
    expect(hasBackendConfig()).toBe(false);

    // The Cloud API URL comes from the build config / env, never localStorage.
    vi.stubEnv("VITE_CLOUD_API_URL", "https://fc.example.com");
    vi.resetModules();
    const fresh = await import("@/lib/backend/provider");
    expect(fresh.hasBackendConfig()).toBe(true);
  });
});
