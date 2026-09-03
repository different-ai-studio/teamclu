import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "./auth-store";
import { trackEvent } from "@/lib/analytics";

export async function setLocalCacheTeamGate(teamId: string | null): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("local_cache_set_current_team", { teamId });
  } catch (error) {
    // Non-fatal: browser preview or missing tauri runtime. The gate is a
    // defense-in-depth layer, not a correctness requirement.
    console.debug("[CurrentTeam] local_cache_set_current_team unavailable", error);
  }
}

interface CurrentTeam {
  id: string;
  name: string;
  slug: string;
}

interface CurrentTeamMember {
  id: string;
  displayName: string;
  role: string | null;
  joinedAt: string | null;
}

/**
 * Persisted snapshot of the resolved current team. Cached to localStorage so a
 * returning user can render the shell optimistically on cold start instead of
 * blocking first paint behind the ~1.4–1.8s team-bootstrap network round-trips
 * (listCurrentUserTeams + member). The live `load()` still runs in the
 * background (App mounts and calls it) to revalidate and reconcile.
 */
interface CachedCurrentTeam {
  team: CurrentTeam | null;
  currentMember: CurrentTeamMember | null;
  /** Auth user id the cache belongs to — guards against cross-user reuse. */
  teamUserId: string | null;
}

const CACHE_KEY = "teamclu:current-team";

export function readCachedCurrentTeam(): CachedCurrentTeam | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCurrentTeam;
    // Only honor a cache that actually identifies a team and its owning user.
    if (!parsed?.team?.id || !parsed.teamUserId) return null;
    return {
      team: parsed.team,
      currentMember: parsed.currentMember ?? null,
      teamUserId: parsed.teamUserId,
    };
  } catch {
    return null;
  }
}

export function writeCachedCurrentTeam(snapshot: CachedCurrentTeam): void {
  try {
    if (!snapshot.team || !snapshot.teamUserId) {
      localStorage.removeItem(CACHE_KEY);
      return;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Private mode / quota / no localStorage — the cache is a best-effort
    // optimization, never a correctness requirement.
  }
}

/** Initial store slice, hydrated synchronously from the persisted cache. */
export function initialCurrentTeamState(): Pick<State, "team" | "currentMember" | "teamUserId"> {
  const cached = readCachedCurrentTeam();
  return {
    team: cached?.team ?? null,
    currentMember: cached?.currentMember ?? null,
    teamUserId: cached?.teamUserId ?? null,
  };
}

type TeamListRow = { id: string; name: string; slug?: string | null };

type ResolveTeamFromListResult =
  | { action: "revalidate"; row: TeamListRow }
  | { action: "preserve" }
  | { action: "clear" }
  | { action: "no_selection" };

/** Pure team resolution for the active-org listing. Never silently picks rows[0]. */
export function resolveTeamFromActiveOrgList(
  rows: TeamListRow[],
  held: CurrentTeam | null,
  sessionUserId: string,
  teamUserId: string | null,
): ResolveTeamFromListResult {
  const matched = held ? rows.find((t) => t.id === held.id) : undefined;
  if (matched) return { action: "revalidate", row: matched };

  if (held && teamUserId === sessionUserId) {
    return { action: "preserve" };
  }

  if (!held) {
    return rows.length === 0 ? { action: "clear" } : { action: "no_selection" };
  }

  return { action: "clear" };
}

interface State {
  team: CurrentTeam | null;
  currentMember: CurrentTeamMember | null;
  /** Auth user id the current `team` was resolved for. Guards the RLS-lag
   * preserve below from carrying one user's team into another's session. */
  teamUserId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  /**
   * Set the current team WITHOUT touching the server-side active org.
   * Internal: only safe when the team is already inside the active org.
   * Every other caller must use `enterTeam`.
   */
  reloadAndSwitchTo: (teamId: string, opts?: { userId?: string }) => Promise<void>;
  enterTeam: (teamId: string, opts?: { assumeActive?: boolean }) => Promise<void>;
  switchToTeam: (teamId: string) => Promise<void>;
  setActiveTeam: (team: CurrentTeam) => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
  /** Rename the current user's own member actor (their display name). */
  renameCurrentMember: (newName: string) => Promise<boolean>;
}

export const useCurrentTeamStore = create<State>((set, get) => ({
  ...initialCurrentTeamState(),
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    const { session, loading: authLoading } = useAuthStore.getState();
    if (!session) {
      // No session YET is not the same as no session. On cold start the auth
      // store begins `{ session: null, loading: true }` and only resolves after
      // a round trip; clearing here on that first pass threw away the snapshot
      // `initialCurrentTeamState()` had just hydrated, and left `team: null`
      // until the network answered. Anything reading the current team in that
      // window saw a signed-out shell — including the client model MRU, whose
      // lookup is keyed by team and so reported "never picked a model" and made
      // the first send after every launch stop for a model pick.
      if (authLoading) {
        set({ loading: false, error: null });
        return;
      }
      await setLocalCacheTeamGate(null);
      set({ team: null, currentMember: null, teamUserId: null, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    let resolution: ResolveTeamFromListResult;
    try {
      const rows = await getBackend().teams.listCurrentUserTeams({ limit: 50 });
      resolution = resolveTeamFromActiveOrgList(
        rows,
        get().team,
        session.user.id,
        get().teamUserId,
      );
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (resolution.action === "preserve") {
      set({ loading: false });
      return;
    }

    if (resolution.action === "no_selection") {
      set({ loading: false });
      return;
    }

    const activeTeam =
      resolution.action === "revalidate"
        ? {
            id: resolution.row.id,
            name: resolution.row.name,
            slug: resolution.row.slug ?? "",
          }
        : null;
    await setLocalCacheTeamGate(activeTeam?.id ?? null);
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      teamUserId: activeTeam ? session.user.id : null,
      loading: false,
    });
  },

  reloadAndSwitchTo: async (teamId: string, opts) => {
    const session = useAuthStore.getState().session;
    if (!session) {
      await setLocalCacheTeamGate(null);
      set({ team: null, currentMember: null, teamUserId: null, loading: false, error: null });
      return;
    }

    // Gate must be moved BEFORE any local_cache_* call for the new team so the
    // backend accepts hydration loads for the team we're switching to.
    await setLocalCacheTeamGate(teamId);

    set({ loading: true, error: null });
    let data;
    try {
      data = await getBackend().teams.getTeam(teamId);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const activeTeam = data ? { id: data.id, name: data.name, slug: data.slug ?? "" } : null;
    // `activateTeam` can adopt a refresh token for a different phone-linked
    // user. Prefer that freshly returned identity over an auth-store listener
    // tick, otherwise the team is resolved for the prior user and ChatPanel
    // later cannot find its member actor.
    const userId = opts?.userId ?? session.user.id;
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, userId)
      : null;
    set({
      team: activeTeam,
      currentMember,
      teamUserId: activeTeam ? userId : null,
      loading: false,
    });
  },

  /**
   * The single supported way to enter a team.
   *
   * TeamClu is strict single-org: `amux.current_org_id()` gates every
   * team-scoped RLS policy, and a team outside the active org is invisible —
   * reads return nothing and writes are denied. Setting the current team
   * without moving the server-side active org therefore produces a client that
   * believes it is in a team the server will refuse every request for:
   * "Failed to create session", an empty session list, and a local-cache gate
   * pointing at a different team than the UI.
   *
   * So: activate first (which mints a session carrying the new org), adopt it,
   * and only then set the client-side team.
   *
   * `assumeActive` skips the activation round-trip. Only pass it when the team
   * is already known to be in the active org — e.g. it came back from
   * `listCurrentUserTeams`, which is itself an active-org listing.
   */
  enterTeam: async (teamId: string, opts) => {
    let activatedUserId: string | undefined
    if (!opts?.assumeActive) {
      const { refreshToken } = await getBackend().teams.activateTeam(teamId);
      // Installs the JWT carrying the new org_id (fires onAuthStateChange →
      // auth-store.session). Without this the org switch is server-only and
      // the very next request still authenticates as the old org.
      if (refreshToken) {
        const adopted = await getBackend().auth.adoptSession(refreshToken);
        activatedUserId = adopted?.user?.id;
      }
    }
    await get().reloadAndSwitchTo(teamId, { userId: activatedUserId });
  },

  switchToTeam: async (teamId: string) => {
    set({ loading: true, error: null });
    const previousUserId = useAuthStore.getState().session?.user?.id ?? null;
    try {
      await get().enterTeam(teamId);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    // 4) Tauri：daemon 换绑到新 team 的本机 agent（按 device id 找回或新建）。
    //    换 team 不需要传标记——refresh 看到 mismatch 就会换绑。只有「同一个 team
    //    但换了 linked account」需要显式要求，因为那种情况 daemon 指向的 team 没变。
    try {
      const { isTauri } = await import("@/lib/utils");
      if (isTauri()) {
        const { useDaemonOnboardingStore } = await import("./daemon-onboarding");
        const currentUserId = useAuthStore.getState().session?.user?.id ?? null;
        await useDaemonOnboardingStore.getState().refresh({
          forceIdentityRebind: !!previousUserId && !!currentUserId && previousUserId !== currentUserId,
        });
      }
    } catch (e) {
      console.warn("[CurrentTeam] daemon refresh after switch failed", e);
    }
    set({ loading: false });
    void trackEvent("team_switched");
  },

  setActiveTeam: async (team) => {
    const session = useAuthStore.getState().session;
    await setLocalCacheTeamGate(team.id);
    const currentMember = session
      ? await loadCurrentMember(team.id, session.user.id)
      : null;
    set({ team, currentMember, teamUserId: session?.user.id ?? null, loading: false, error: null });
  },

  rename: async (newName) => {
    const team = get().team;
    if (!team) {
      set({ error: "no current team" });
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      set({ error: "team name is required" });
      return false;
    }

    set({ saving: true, error: null });
    try {
      const renamed = await getBackend().teams.renameTeam(team.id, trimmed);
      set({
        team: {
          id: renamed.id || team.id,
          name: renamed.name || trimmed,
          slug: renamed.slug ?? team.slug,
        },
        saving: false,
      });
      return true;
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  renameCurrentMember: async (newName) => {
    const member = get().currentMember;
    if (!member) {
      set({ error: "no current member" });
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      set({ error: "display name is required" });
      return false;
    }
    if (trimmed === member.displayName) return true;

    set({ saving: true, error: null });
    try {
      const updated = await getBackend().actors.updateCurrentActorProfile({
        actorId: member.id,
        displayName: trimmed,
      });
      const nextName = updated.display_name || trimmed;
      set({ currentMember: { ...member, displayName: nextName }, saving: false });

      // Best-effort: refresh the cached Actor so chat/sidebar reflect the new
      // name without a reload. Only patches an already-cached entry.
      try {
        const { useActorsStore } = await import("./actors-store");
        const cached = useActorsStore.getState().get(member.id);
        if (cached) useActorsStore.getState().upsert({ ...cached, displayName: nextName });
      } catch {
        // actors-store unavailable / not yet populated — non-fatal.
      }
      return true;
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },
}));

// Persist the resolved team identity on every change so the next cold start can
// hydrate it synchronously (see initialCurrentTeamState). Writing on every
// state change is cheap and keeps the cache authoritative without threading a
// save call through each resolution site.
useCurrentTeamStore.subscribe((state) => {
  writeCachedCurrentTeam({
    team: state.team,
    currentMember: state.currentMember,
    teamUserId: state.teamUserId,
  });
});

async function loadCurrentMember(teamId: string, userId: string): Promise<CurrentTeamMember | null> {
  try {
    return await getBackend().directory.getCurrentTeamMember(teamId, userId);
  } catch (error) {
    console.warn("[CurrentTeam] failed to load current member", error);
    return null;
  }
}
