import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "./auth-store";
import { useCurrentTeamStore } from "./current-team";
import { isTauri } from "@/lib/utils";
import { loadPinnedSessionIds, savePinnedSessionIds } from "./session-pins";
import { syncSessionWorkspaces } from "@/lib/session/session-workspace-sync";
import { markStartup } from "@/lib/telemetry/startup-perf";
import {
  loadSessionsForTeam,
  loadSessionIdsForActor,
  softDeleteSession,
  upsertSessionsBatch,
  type SessionRow,
} from "@/lib/cache/local-cache";
import { removeLinkSessionEntriesForSession } from "@/lib/extension/link-session";
import { reportLocalCacheFailure } from "@/lib/telemetry/local-cache-error-report";
import type { SessionListCursor, SessionListPage } from "@/lib/backend/types";
import { sortSessionListRows } from "@/lib/session/session-list-sort";

const ARCHIVED_SESSION_IDS_KEY = "teamclu.sessionList.archivedIds";

function readArchivedSessionIds(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(ARCHIVED_SESSION_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function rememberArchivedSessionId(sessionId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const ids = readArchivedSessionIds();
    ids.add(sessionId);
    localStorage.setItem(ARCHIVED_SESSION_IDS_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — non-fatal.
  }
}

/**
 * Drop ids the server no longer considers archived.
 *
 * The list RPC returns only rows with `archived_at is null`, so anything that
 * comes back has been un-archived — by another device, or by the gateway,
 * which un-archives a chat when a new message arrives on it. Without this the
 * local list would keep hiding a session that is demonstrably live again:
 * `rememberArchivedSessionId` only ever adds, so the list outlives the state
 * it was mirroring.
 *
 * Only call this with rows from the server. Rows from the libsql cache are not
 * evidence of anything — archived sessions sit there until they are soft
 * deleted, which is exactly why the local list exists.
 */
function forgetArchivedSessionIds(entries: SessionListEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    const archived = readArchivedSessionIds();
    if (archived.size === 0) return;
    let changed = false;
    for (const row of entries) {
      if (archived.delete(row.id)) changed = true;
    }
    if (!changed) return;
    localStorage.setItem(ARCHIVED_SESSION_IDS_KEY, JSON.stringify([...archived]));
  } catch {
    // localStorage unavailable — non-fatal.
  }
}

function filterArchivedEntries(entries: SessionListEntry[]): SessionListEntry[] {
  const archived = readArchivedSessionIds();
  if (archived.size === 0) return entries;
  return entries.filter((row) => !archived.has(row.id));
}

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
  idea_id: string | null;
  has_unread: boolean;
  /** How the session was created: 'user' | 'cron' | 'gateway'. */
  source?: string | null;
  /** For source='cron', the cron job id that created it. */
  cron_job_id?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function mapCacheToEntry(r: SessionRow): SessionListEntry {
  return {
    id: r.id,
    title: r.title ?? "",
    team_id: r.teamId,
    last_message_at: r.lastMessageAt ?? null,
    last_message_preview: r.lastMessagePreview ?? null,
    mode: (r.mode as SessionListEntry["mode"]) ?? "solo",
    idea_id: r.ideaId ?? null,
    has_unread: false,
    source: r.source ?? null,
    cron_job_id: r.cronJobId ?? null,
    created_at: r.createdAt ?? null,
    updated_at: r.updatedAt ?? null,
  };
}

function sortEntries(entries: SessionListEntry[]): SessionListEntry[] {
  return sortSessionListRows(entries);
}

/**
 * The team the list should be showing.
 *
 * `scopeTeamId` is null until the first page commits, and `resetClientChatState`
 * puts it back to null on every identity change — so it cannot be the only
 * source. The active team is: `enterTeam` sets it synchronously, before the
 * callers that seed rows for the team being entered (cron's "查看对话" does
 * exactly that), and long before the list's own load resolves.
 */
function resolveScopeTeamId(scopeTeamId: string | null): string | null {
  if (scopeTeamId) return scopeTeamId;
  return useCurrentTeamStore.getState().team?.id ?? null;
}

/**
 * Drop rows that do not belong to the team the list is currently scoped to.
 *
 * The server page is already narrowed by `teamId`, but rows also reach the
 * store sideways — MQTT live events (the client subscribes to every team's
 * topic), the inbox handler, and `open-session-deeplink`, which seeds a row for
 * a session in the team it is about to switch into. Without this a foreign row
 * lands in a list that is supposed to show one team.
 *
 * Everything passes only when no team is known at all (headless callers and
 * tests) — a live client always has one, see `resolveScopeTeamId`.
 */
function filterToScope(
  entries: SessionListEntry[],
  scopeTeamId: string | null,
): SessionListEntry[] {
  const scope = resolveScopeTeamId(scopeTeamId);
  if (!scope) return entries;
  return entries.filter((row) => row.team_id === scope);
}

/**
 * Surface a failed list refresh to the user.
 *
 * The store's `error` field has no renderer — nothing reads it — so a failing
 * GET /v1/sessions used to be completely silent: the sidebar just kept showing
 * whatever it already had, with no hint that it had gone stale. The refresh is
 * also debounced off realtime events (App.tsx), so a backend that is down would
 * fire this repeatedly; the fixed toast id collapses those into one.
 *
 * Imported lazily so the store keeps working headless (tests, non-UI callers).
 */
function notifyRefreshFailed(message: string): void {
  void (async () => {
    const [{ toast }, { default: i18n }] = await Promise.all([
      import("sonner"),
      import("@/lib/i18n"),
    ]);
    toast.error(i18n.t("sessions.list.refreshFailed"), {
      id: "session-list-refresh-failed",
      description: message,
    });
  })().catch(() => {
    // Toasting is best-effort; never let it mask the original failure.
  });
}

interface State {
  rows: SessionListEntry[];
  loading: boolean;
  error: string | null;
  pinnedSessionIds: string[];
  highlightedSessionIds: string[];
  hasMore: boolean;
  nextCursor: SessionListCursor | null;
  listKind: SessionListKind;
  regularHasMore: boolean;
  regularNextCursor: SessionListCursor | null;
  cronHasMore: boolean;
  cronNextCursor: SessionListCursor | null;
  /**
   * Teams the server has returned at least one session row for since sign-in.
   * Gates the empty-response guard in `loadFirstPage` — see the comment there.
   *
   * Per team rather than a single flag: this PR's whole subject is that
   * visibility is resolved per team, so "the server proved it can see my
   * sessions in team A" says nothing about team B.
   */
  serverConfirmedTeams: string[];
  /**
   * Teams whose cached rows were already kept once in the face of an empty
   * server page. Bounds that guard to a single refresh, so a team that really
   * is empty stops showing stale libsql rows on the next load instead of
   * keeping them for the rest of the session.
   */
  emptyPageKeptTeams: string[];
  /**
   * Team the current `rows` belong to; null until the first page loads. Every
   * fetch is narrowed to it, and rows arriving from side channels are filtered
   * against it (see `filterToScope`).
   */
  scopeTeamId: string | null;
  /**
   * Last team whose first page actually committed. `scopeTeamId` is set before
   * the fetch (so the list cannot paint another team's rows while it is in
   * flight), which makes it useless for "has this team loaded yet" — a failed
   * fetch would otherwise look identical to a successful one and never retry.
   */
  loadedTeamId: string | null;
  load: () => Promise<void>;
  loadFirstPage: (limit?: number, kind?: SessionListKind) => Promise<void>;
  loadMore: (limit?: number) => Promise<void>;
  setListKind: (kind: SessionListKind) => void;
  upsertRows: (rows: SessionListEntry[]) => void;
  patchRow: (sessionId: string, patch: Partial<SessionListEntry>) => void;
  /** Patch preview fields and re-sort by last_message_at. */
  bumpLastMessage: (
    sessionId: string,
    patch: Pick<SessionListEntry, "last_message_preview" | "last_message_at"> &
      Partial<Pick<SessionListEntry, "has_unread">>,
  ) => void;
  removeRow: (sessionId: string) => void;
  markSessionViewed: (sessionId: string, lastReadMessageId?: string | null) => Promise<void>;
  initPinnedSessionIds: (teamId?: string | null) => void;
  toggleSessionPinned: (sessionId: string, teamId?: string | null) => void;
  addHighlightedSession: (sessionId: string, ttlMs?: number) => void;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<boolean>;
  /** Like archiveSession but does not surface failures on the store error field. */
  archiveSessionQuiet: (sessionId: string) => Promise<boolean>;
}

type SessionListKind = "regular" | "cron";

function isKind(row: SessionListEntry, kind: SessionListKind): boolean {
  return kind === "cron" ? row.source === "cron" : row.source !== "cron";
}

function filterToKind(rows: SessionListEntry[], kind: SessionListKind): SessionListEntry[] {
  return rows.filter((row) => isKind(row, kind));
}

function replaceKindRows(
  existing: SessionListEntry[],
  incoming: SessionListEntry[],
  kind: SessionListKind,
): SessionListEntry[] {
  return sortEntries([...existing.filter((row) => !isKind(row, kind)), ...incoming]);
}

function paginationPatch(
  kind: SessionListKind,
  nextCursor: SessionListCursor | null,
): Partial<State> {
  const hasMore = nextCursor != null;
  return kind === "cron"
    ? { cronHasMore: hasMore, cronNextCursor: nextCursor, hasMore, nextCursor }
    : { regularHasMore: hasMore, regularNextCursor: nextCursor, hasMore, nextCursor };
}

function mergeRows(existing: SessionListEntry[], incoming: SessionListEntry[]): SessionListEntry[] {
  const byId = new Map(existing.map((row) => [row.id, row] as const));
  for (const row of incoming) byId.set(row.id, row);
  return sortEntries(Array.from(byId.values()));
}

function cursorFromRows(rows: SessionListEntry[]): State["nextCursor"] {
  if (rows.length === 0) return null;
  const row = rows[rows.length - 1];
  return {
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    id: row.id,
  };
}

async function loadPage(
  limit: number,
  cursor: State["nextCursor"],
  teamId: string,
  kind: SessionListKind,
) {
  return getBackend().sessions.listCurrentActorSessions({
    limit,
    cursor,
    teamId,
    kind,
  });
}

/**
 * De-duplicates concurrent first-page loads for the same team.
 *
 * `loadFirstPage` is called from several independent places — mount, the
 * team-scope effect, the identity-change effect, and the debounced realtime
 * refresh — which on a team switch fire within the same tick. Without this they
 * each issue their own request and each overwrite `rows` on arrival.
 */
let firstPageInFlight: Promise<void> | null = null;
let firstPageInFlightScope: string | null = null;

/**
 * Bumped by every first-page run; a run commits only while it is still the
 * latest one.
 *
 * The de-dupe above only shares a promise between callers asking for the SAME
 * team, so a team switch deliberately starts a second run while the first is
 * still awaiting its page. Without this counter that first run would come back
 * and overwrite the new team's list with the team the user just left — the
 * exact cross-team leak the scoping exists to prevent. `scopeTeamId` cannot
 * serve as the check: `resetClientChatState` nulls it mid-flight on the same
 * switch, which would make a live run look stale.
 */
let firstPageGeneration = 0;

function resolveNextCursor(page: SessionListPage): State["nextCursor"] {
  return page.nextCursor === undefined ? cursorFromRows(page.rows) : page.nextCursor;
}

function applyArchivedSessionLocalState(
  get: () => State,
  sessionId: string,
  archivedAt: string,
): void {
  rememberArchivedSessionId(sessionId);
  void removeLinkSessionEntriesForSession(sessionId).catch((error) => {
    console.warn("[session-list] failed to clear link-session map for archived session", error);
  });
  if (isTauri()) {
    void softDeleteSession(sessionId, archivedAt).catch(() => {});
  }
  get().removeRow(sessionId);
}

/**
 * One first-page load, scoped to `teamId`. Extracted from the store action so
 * concurrent callers can share a single in-flight promise (see
 * `firstPageInFlight`).
 */
async function loadFirstPageForTeam(
  limit: number,
  teamId: string,
  kind: SessionListKind,
  generation: number,
  set: (partial: Partial<State>) => void,
  get: () => State,
): Promise<void> {
  // True once a newer first-page run has started. Checked after every await,
  // before every write.
  const superseded = () => generation !== firstPageGeneration;

  // Team switch: the rows on screen belong to the team being left. Drop them
  // before the fetch rather than after, so the list never shows another team's
  // sessions while the new page is in flight.
  const previousScope = get().scopeTeamId;
  if (previousScope !== null && previousScope !== teamId) {
    set({
      rows: [],
      hasMore: false,
      nextCursor: null,
      regularHasMore: false,
      regularNextCursor: null,
      cronHasMore: false,
      cronNextCursor: null,
    });
  }
  set({ loading: true, error: null, scopeTeamId: teamId });
  markStartup("session-list:start");

  // ── Phase 1: hydrate instantly from local cache (Tauri only) ────────────
  // Skip when we already have RPC rows for this team — reloading would flash
  // archived sessions that still sit in libsql until soft-deleted.
  //
  // The cache holds every session of the team, not just the viewer's, so the
  // rows are narrowed to the ones the current member actually participates in —
  // otherwise the offline paint shows sessions the server page will then
  // remove. `teamId` is the active team, so the member actor for that team is
  // the right one to narrow by.
  const existingRows = filterToKind(get().rows, kind);
  const currentMemberActorId = useCurrentTeamStore.getState().currentMember?.id ?? null;
  if (isTauri() && currentMemberActorId && existingRows.length === 0) {
    // The cache is an accelerator, never a gate. A rejection here (most
    // often the current-team gate disagreeing with `teamId`) used to reject
    // this whole function, leaving `loading: true` forever — the list span
    // its spinner and the rejection surfaced as an unhandled rejection.
    try {
      const [localRows, actorSessionIds] = await Promise.all([
        loadSessionsForTeam(teamId),
        loadSessionIdsForActor(teamId, currentMemberActorId),
      ]);
      if (superseded()) return;
      const actorSessionIdSet = new Set(actorSessionIds);
      const currentActorRows = filterToKind(
        localRows.filter((row) => actorSessionIdSet.has(row.id)).map(mapCacheToEntry),
        kind,
      );
      if (currentActorRows.length > 0) {
        set({
          rows: replaceKindRows(
            get().rows,
            filterArchivedEntries(sortEntries(currentActorRows)),
            kind,
          ),
        });
        markStartup("session-list:local-cache");
      }
    } catch (error) {
      reportLocalCacheFailure("session_load_team", error, { teamId });
    }
  }

  let page: SessionListPage;
  try {
    page = await loadPage(limit, null, teamId, kind);
  } catch (error) {
    if (superseded()) return;
    const message = error instanceof Error ? error.message : String(error);
    // `loadedTeamId` is deliberately left alone: this team has NOT loaded, and
    // the effect in App.tsx keys its retry on that.
    set({ loading: false, error: message });
    notifyRefreshFailed(message);
    return;
  }
  if (superseded()) return;
  const rows = filterToKind(filterToScope(page.rows, teamId), kind);
  const nextCursor = resolveNextCursor(page);

  // ── Empty-response guard ───────────────────────────────────────────────
  // GET /v1/sessions answers "you have no sessions" and "I cannot see your
  // sessions" with the same 200 + `items: []`: every visibility gate on that
  // endpoint fails closed (no actor row for the caller, no
  // session_participants row, RLS/org scoping) and returns an empty list
  // rather than an error. Until the server has handed us a row at least
  // once, an empty page is therefore not evidence that the list is empty —
  // and overwriting the phase-1 hydrate with it blanks a list the user can
  // plainly see, while the rows still sit in libsql.
  //
  // Once a page for this team has come back with rows, it is confirmed and a
  // later empty page is taken at face value, so archiving the last session
  // (here or on another device) still empties the list as it should.
  //
  // The guard also fires at most ONCE per team. A team the user really has no
  // sessions in never gets confirmed, so an unbounded guard would keep serving
  // whatever the libsql hydrate found for the rest of the session — sessions
  // that were archived on another device would stay in the sidebar forever.
  // Keeping them through one refresh is the hedge against a fail-closed
  // visibility gate; keeping them through every refresh is just a stale list.
  // Preserve the historical regular-session key; cron needs its own proof so
  // one type cannot disable the empty-page safety guard for the other.
  const confirmationKey = kind === "regular" ? teamId : `${teamId}:cron`;
  const teamConfirmed = get().serverConfirmedTeams.includes(confirmationKey);
  const alreadyKeptOnce = get().emptyPageKeptTeams.includes(confirmationKey);
  const visibleKindRows = filterToKind(get().rows, kind);
  if (rows.length === 0 && visibleKindRows.length > 0 && !teamConfirmed && !alreadyKeptOnce) {
    console.warn(
      "[session-list] server returned 0 sessions and none were confirmed before; keeping cached rows",
    );
    set({
      loading: false,
      ...paginationPatch(kind, null),
      // Kept rows are cache rows; narrow them to this team so a row seeded for
      // another team before the first load cannot survive here.
      rows: replaceKindRows(
        get().rows,
        filterToKind(filterToScope(get().rows, teamId), kind),
        kind,
      ),
      scopeTeamId: teamId,
      emptyPageKeptTeams: [...get().emptyPageKeptTeams, confirmationKey],
    });
    markStartup("session-list:loaded");
    return;
  }

  if (isTauri() && rows.length > 0) {
    const cacheRows: SessionRow[] = rows.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      title: r.title ?? null,
      mode: r.mode ?? null,
      primaryAgentId: null,
      ideaId: r.idea_id ?? null,
      summary: null,
      lastMessagePreview: r.last_message_preview ?? null,
      lastMessageAt: r.last_message_at ?? null,
      createdBy: null,
      metadataJson: null,
      source: r.source ?? null,
      cronJobId: r.cron_job_id ?? null,
      createdAt: r.created_at ?? new Date().toISOString(),
      updatedAt: r.updated_at ?? new Date().toISOString(),
      deletedAt: null,
      syncedAt: new Date().toISOString(),
    }));
    if (superseded()) return;
    try {
      await upsertSessionsBatch(cacheRows);
    } catch (error) {
      // Same contract as the hydrate above: a cache write must never stop
      // the freshly-fetched rows from rendering.
      reportLocalCacheFailure("session_upsert_batch", error, { teamId });
    }
    // Fire-and-forget: refresh the viewer's workspace context so newly
    // connected agents and newly registered workspaces are picked up. The
    // session → workspace links themselves are no longer prefetched here —
    // they come off each session's participant rows on demand (ADR-0005).
    void syncSessionWorkspaces(teamId).catch(() => {});
  }

  if (superseded()) return;
  forgetArchivedSessionIds(rows);
  set({
    rows: replaceKindRows(get().rows, filterArchivedEntries(sortEntries(rows)), kind),
    loading: false,
    ...paginationPatch(kind, nextCursor),
    // Re-asserted, not assumed: resetClientChatState nulls the scope on the
    // same team switch that started this run, and its follow-up loadFirstPage
    // is swallowed by the in-flight de-dupe — so this commit is the only thing
    // that can put the scope back.
    scopeTeamId: teamId,
    loadedTeamId: teamId,
    serverConfirmedTeams:
      rows.length > 0 && !get().serverConfirmedTeams.includes(confirmationKey)
        ? [...get().serverConfirmedTeams, confirmationKey]
        : get().serverConfirmedTeams,
    // A page that actually arrived supersedes the one-shot hedge above.
    emptyPageKeptTeams: get().emptyPageKeptTeams.filter((id) => id !== confirmationKey),
  });
  markStartup("session-list:loaded");
}

export const useSessionListStore = create<State>((set, get) => ({
  rows: [],
  loading: false,
  error: null,
  pinnedSessionIds: [],
  highlightedSessionIds: [],
  hasMore: false,
  nextCursor: null,
  listKind: "regular",
  regularHasMore: false,
  regularNextCursor: null,
  cronHasMore: false,
  cronNextCursor: null,
  serverConfirmedTeams: [],
  emptyPageKeptTeams: [],
  scopeTeamId: null,
  loadedTeamId: null,
  load: async () => {
    await get().loadFirstPage();
  },
  loadFirstPage: async (limit = 50, kind = get().listKind) => {
    get().setListKind(kind);
    const session = useAuthStore.getState().session;
    if (!session) {
      set({
        rows: [],
        loading: false,
        error: null,
        hasMore: false,
        nextCursor: null,
        listKind: "regular",
        regularHasMore: false,
        regularNextCursor: null,
        cronHasMore: false,
        cronNextCursor: null,
        // Signing out re-arms the empty-response guard: the next account's
        // first page has proven nothing yet, in any team.
        serverConfirmedTeams: [],
        emptyPageKeptTeams: [],
        scopeTeamId: null,
        loadedTeamId: null,
      });
      return;
    }

    // The active team scopes both the libsql hydrate and the server page.
    // There is no fallback on purpose: guessing a team (from the previous run,
    // or from rows already on screen) is how the list ends up fetching one
    // team while the rest of the app is in another. AuthGate holds the startup
    // skeleton until team bootstrap resolves, so by the time anything can call
    // this there IS a current team; a null here means the caller ran outside
    // that guarantee, and the effect in App.tsx re-runs the moment a team
    // lands.
    const teamId = useCurrentTeamStore.getState().team?.id ?? null;
    if (!teamId) {
      console.warn("[session-list] skipping load — no active team");
      set({ loading: false });
      return;
    }

    const requestScope = `${teamId}:${kind}`;
    if (firstPageInFlight && firstPageInFlightScope === requestScope) {
      return firstPageInFlight;
    }
    const generation = ++firstPageGeneration;
    const run = loadFirstPageForTeam(limit, teamId, kind, generation, set, get);
    firstPageInFlight = run;
    firstPageInFlightScope = requestScope;
    try {
      await run;
    } finally {
      if (firstPageInFlight === run) {
        firstPageInFlight = null;
        firstPageInFlightScope = null;
      }
    }
  },
  loadMore: async (limit = 50) => {
    const session = useAuthStore.getState().session;
    if (!session) return;
    const kind = get().listKind;
    const cursor = kind === "cron" ? get().cronNextCursor : get().regularNextCursor;
    if (!cursor) return;

    // Page 2+ must carry the same scope as page 1 — otherwise scrolling pulls
    // in every team's sessions again, one page at a time.
    const teamId = resolveScopeTeamId(get().scopeTeamId);
    if (!teamId) return;
    // A first-page run started after this one supersedes it: it owns `rows` and
    // `nextCursor`, so appending a page built on the old cursor would splice a
    // stale window into the list.
    const generation = firstPageGeneration;
    set({ loading: true, error: null });
    let page: SessionListPage;
    try {
      page = await loadPage(limit, cursor, teamId, kind);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // A team switch mid-flight makes this page stale; dropping it is correct
    // because loadFirstPage has already reset rows for the new scope.
    if (resolveScopeTeamId(get().scopeTeamId) !== teamId || generation !== firstPageGeneration) {
      set({ loading: false });
      return;
    }
    const rows = filterToKind(filterToScope(page.rows, teamId), kind);
    const nextCursor = resolveNextCursor(page);
    forgetArchivedSessionIds(rows);
    const nextRows = filterArchivedEntries(mergeRows(get().rows, rows));
    set({
      rows: nextRows,
      loading: false,
      ...paginationPatch(kind, nextCursor),
    });
  },
  setListKind: (kind) => set((state) => ({
    listKind: kind,
    hasMore: kind === "cron" ? state.cronHasMore : state.regularHasMore,
    nextCursor: kind === "cron" ? state.cronNextCursor : state.regularNextCursor,
  })),
  upsertRows: (rows) =>
    set((state) => ({
      rows: mergeRows(state.rows, filterToScope(rows, state.scopeTeamId)),
    })),
  patchRow: (sessionId, patch) => set((state) => ({
    rows: state.rows.map((row) =>
      row.id === sessionId ? { ...row, ...patch } : row,
    ),
  })),
  bumpLastMessage: (sessionId, patch) =>
    set((state) => ({
      rows: sortEntries(
        state.rows.map((row) =>
          row.id === sessionId ? { ...row, ...patch } : row,
        ),
      ),
    })),
  removeRow: (sessionId) => set((state) => ({
    rows: state.rows.filter((row) => row.id !== sessionId),
  })),
  markSessionViewed: async (sessionId, lastReadMessageId = null) => {
    try {
      await getBackend().sessions.markCurrentActorSessionViewed(sessionId, lastReadMessageId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    get().patchRow(sessionId, { has_unread: false });
  },
  initPinnedSessionIds: (teamId = null) => {
    set({ pinnedSessionIds: loadPinnedSessionIds(teamId) });
  },
  toggleSessionPinned: (sessionId, teamId = null) => {
    const cur = get().pinnedSessionIds;
    const next = cur.includes(sessionId)
      ? cur.filter((id) => id !== sessionId)
      : [...cur, sessionId];
    savePinnedSessionIds(teamId, next);
    set({ pinnedSessionIds: next });
  },
  addHighlightedSession: (sessionId, ttlMs = 4000) => {
    const cur = get().highlightedSessionIds;
    if (cur.includes(sessionId)) return;
    set({ highlightedSessionIds: [...cur, sessionId] });
    setTimeout(() => {
      const latest = useSessionListStore.getState().highlightedSessionIds;
      useSessionListStore.setState({
        highlightedSessionIds: latest.filter((id) => id !== sessionId),
      });
    }, ttlMs);
  },
  updateSessionTitle: async (sessionId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await getBackend().sessions.updateSessionTitle(sessionId, trimmed);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    get().patchRow(sessionId, { title: trimmed });
  },
  archiveSession: async (sessionId) => {
    const archivedAt = new Date().toISOString();
    try {
      await getBackend().sessions.archiveSession(sessionId, archivedAt);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    applyArchivedSessionLocalState(get, sessionId, archivedAt);
    return true;
  },
  archiveSessionQuiet: async (sessionId) => {
    const archivedAt = new Date().toISOString();
    try {
      await getBackend().sessions.archiveSession(sessionId, archivedAt);
    } catch (error) {
      console.warn("[session-list] archive failed", sessionId, error);
      return false;
    }
    applyArchivedSessionLocalState(get, sessionId, archivedAt);
    return true;
  },
}));
