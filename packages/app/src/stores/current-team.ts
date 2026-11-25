import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { isTauri } from "@/lib/utils";
import { markLocalAgentInstallPending } from "./local-agent-install";
import { useAuthStore } from "./auth-store";

// The desktop command is last-write-wins and has no generation of its own.
// Two invokes that are in flight together can be applied in either order, so
// an older team can land after the team the user just entered. Calls go
// through one chain: a newer request is not sent until the previous invoke
// has finished, and a rejected invoke does not stall the requests behind it.
let gateTail: Promise<void> = Promise.resolve();

export async function setLocalCacheTeamGate(teamId: string | null): Promise<void> {
  const run = gateTail.then(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("local_cache_set_current_team", { teamId });
    } catch (error) {
      // Non-fatal: browser preview or missing tauri runtime. The gate is a
      // defense-in-depth layer, not a correctness requirement.
      console.debug("[CurrentTeam] local_cache_set_current_team unavailable", error);
    }
  });
  gateTail = run;
  return run;
}

// `load()` awaits the team list, the cache gate, and the member read before
// it writes. A switch moves the gate before it replaces the team object, so a
// comparison of that object alone still looks current and lets the old load
// point the gate back. Explicit team changes bump this counter first; `load`
// remembers the value it started with and drops the result when it no longer
// matches. Depth covers a load that starts while a change is already in
// progress, before the counter moves again.
let teamMutationEpoch = 0;
let teamMutationDepth = 0;

async function withTeamMutation<T>(body: () => Promise<T>): Promise<T> {
  teamMutationDepth += 1;
  teamMutationEpoch += 1;
  try {
    return await body();
  } finally {
    teamMutationDepth -= 1;
  }
}

export interface CurrentTeam {
  id: string;
  name: string;
  slug: string;
}

interface CurrentTeamMember {
  id: string;
  displayName: string;
  /** Org role assignments — source of truth for `useTeamPermissions`. */
  roles?: Array<{ id?: string; code: string; name?: string }>;
  /** Transitional derived highest privilege; prefer `roles`. */
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
    const epochAtStart = teamMutationEpoch;
    const heldTeam = get().team;
    const heldTeamUserId = get().teamUserId;
    const heldUserId = useAuthStore.getState().session?.user.id ?? null;
    // Object identity, not team id: leaving A and coming back creates a new
    // team object, and the load that started on the first visit must not write
    // over that return. A changed user id is the same kind of stale context
    // even when the team object has not been replaced yet.
    const isCurrent = () => {
      if (teamMutationDepth !== 0 || teamMutationEpoch !== epochAtStart) return false;
      const liveUserId = useAuthStore.getState().session?.user.id ?? null;
      if (liveUserId !== heldUserId) return false;
      const live = get();
      return live.team === heldTeam && live.teamUserId === heldTeamUserId;
    };
    // A caller that lost the race before doing any work must not clear
    // `loading` or `error` — those belong to the operation that replaced it.
    if (!isCurrent()) return;

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
      if (!isCurrent()) return;
      set({ team: null, currentMember: null, teamUserId: null, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    let resolution: ResolveTeamFromListResult;
    try {
      const rows = await getBackend().teams.listCurrentUserTeams({ limit: 50 });
      if (!isCurrent()) return;
      resolution = resolveTeamFromActiveOrgList(
        rows,
        heldTeam,
        session.user.id,
        heldTeamUserId,
      );
    } catch (error) {
      if (!isCurrent()) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (resolution.action === "preserve" || resolution.action === "no_selection") {
      if (!isCurrent()) return;
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
    if (!isCurrent()) return;
    await setLocalCacheTeamGate(activeTeam?.id ?? null);
    if (!isCurrent()) return;
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    if (!isCurrent()) return;
    set({
      team: activeTeam,
      currentMember,
      teamUserId: activeTeam ? session.user.id : null,
      loading: false,
    });
  },

  reloadAndSwitchTo: async (teamId: string, opts) => withTeamMutation(async () => {
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
  }),

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
  enterTeam: async (teamId: string, opts) => withTeamMutation(async () => {
    let activatedUserId: string | undefined
    // A support session's JWT already carries the customer org, and the server
    // refuses to mint the support account any other session (it would escape
    // the support grant's expiry), so activation is skipped there.
    const { isInSupportSession } = await import("@/lib/admin/support-session")
    if (!opts?.assumeActive && !isInSupportSession()) {
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
  }),

  switchToTeam: async (teamId: string) => withTeamMutation(async () => {
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
      if (isTauri()) {
        markLocalAgentInstallPending(teamId);
        const { refreshDaemonUnlessSkipped } = await import("@/lib/daemon/local-agent-install");
        const currentUserId = useAuthStore.getState().session?.user?.id ?? null;
        await refreshDaemonUnlessSkipped({
          forceIdentityRebind: !!previousUserId && !!currentUserId && previousUserId !== currentUserId,
        });
      }
    } catch (e) {
      console.warn("[CurrentTeam] daemon refresh after switch failed", e);
    }
    set({ loading: false });
  }),

  setActiveTeam: async (team) => withTeamMutation(async () => {
    const session = useAuthStore.getState().session;
    await setLocalCacheTeamGate(team.id);
    const currentMember = session
      ? await loadCurrentMember(team.id, session.user.id)
      : null;
    set({ team, currentMember, teamUserId: session?.user.id ?? null, loading: false, error: null });
  }),

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
