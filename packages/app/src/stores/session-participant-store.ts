import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { isAgentActorType } from "@/lib/actor/actor-type";
import {
  loadActorsByIds,
  loadSessionParticipants,
} from "@/lib/cache/local-cache";
import { syncParticipantsForSession } from "@/lib/sync/session-participant-sync";
import { isTauri } from "@/lib/utils";

export type SessionParticipantInfo = {
  actorId: string;
  displayName: string;
  avatarUrl: string | null;
  isAgent: boolean;
  /**
   * A person who reached this session through a channel (WeCom, Feishu) rather
   * than a TeamClu account — `actors.actor_type = 'external'`.
   *
   * Kept separate from `isAgent` instead of collapsing into "not an agent":
   * an external is mentionable like a member, but is NOT a team member, and
   * routing rules that count humans (solo-session agent fallback) must not
   * count them or a gateway chat stops looking solo the moment its own sender
   * joins the roster.
   */
  isExternal: boolean;
};

function isMentionableParticipant(actorType: string | null | undefined): boolean {
  // `external` is here because @-mentioning the person on the other end of a
  // gateway chat is how a desktop user pushes a message out to them. They were
  // in `session_participants` all along — this filter is what hid them.
  return (
    actorType === "member" ||
    actorType === "external" ||
    isAgentActorType(actorType)
  );
}

type State = {
  participantsBySession: Record<string, SessionParticipantInfo[]>;
  loadingBySession: Record<string, boolean>;
  errorBySession: Record<string, string | null>;
  ensureParticipants: (
    sessionIds: string[],
    options?: { force?: boolean },
  ) => Promise<void>;
  refreshSession: (sessionId: string, teamId?: string | null) => Promise<void>;
  /**
   * Publish a roster resolved elsewhere. The participants sheet loads its own
   * rich rows (statuses, agent types, presence) in one round-trip and used to
   * keep them entirely to itself — which is how it could list an agent that the
   * mention popover, reading this store, did not know existed. Whoever learns
   * the roster tells the store, so there is one answer to "who is in this
   * session" even though the detail fetch stays where it is.
   */
  setParticipants: (sessionId: string, participants: SessionParticipantInfo[]) => void;
  invalidateSessions: (sessionIds: string[]) => void;
};

async function loadParticipantInfoFromCloud(
  sessionId: string,
): Promise<SessionParticipantInfo[]> {
  const actors = await getBackend().sessionMembers.listParticipants(sessionId);
  return actors
    .filter((a) => isMentionableParticipant(a.actor_type))
    .map((actor) => ({
      actorId: actor.id,
      displayName: actor.display_name?.trim() || actor.id,
      avatarUrl: actor.avatar_url ?? null,
      isAgent: isAgentActorType(actor.actor_type),
      isExternal: actor.actor_type === "external",
    }));
}

async function loadParticipantInfoFromLocalCache(
  sessionId: string,
): Promise<SessionParticipantInfo[]> {
  const parts = await loadSessionParticipants(sessionId);
  if (parts.length === 0) return [];
  const actorIds = parts.map((p) => p.actorId);
  const actors = await loadActorsByIds(actorIds);
  const byId = new Map(actors.map((a) => [a.id, a] as const));
  return parts
    .map((p) => {
      const actor = byId.get(p.actorId);
      if (!actor) return null;
      return {
        actorId: actor.id,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl ?? null,
        isAgent: isAgentActorType(actor.actorType),
        isExternal: actor.actorType === "external",
      };
    })
    .filter((p): p is SessionParticipantInfo => p !== null);
}

/**
 * The local cache is an accelerator, never the truth.
 *
 * Nothing fills it when a session is merely opened — `syncParticipantsForSession`
 * runs on a forced refresh, on the actor sheet's add/remove, on MQTT
 * participant events and on a cache rebuild, and nowhere else. A session
 * created server-side (cron) therefore has an empty local roster, and every
 * consumer that treated that empty array as authoritative concluded "no
 * participants": the sole-agent routing in `resolve-session-mention-ids` sent
 * the message with no target (the agent never answered), the composer never
 * engaged the agent pill, and the mention popover had nothing to offer — while
 * the participants sheet, which reads the cloud directly, listed the agent the
 * whole time.
 *
 * So an empty local read means "unknown", and we ask the cloud. A cloud answer
 * of zero participants is the only empty this store will publish.
 */
async function loadParticipantInfo(sessionId: string): Promise<SessionParticipantInfo[]> {
  if (!isTauri()) {
    return loadParticipantInfoFromCloud(sessionId);
  }
  const local = await loadParticipantInfoFromLocalCache(sessionId);
  if (local.length > 0) return local;
  return loadParticipantInfoFromCloud(sessionId);
}

export const useSessionParticipantStore = create<State>((set, get) => ({
  participantsBySession: {},
  loadingBySession: {},
  errorBySession: {},
  ensureParticipants: async (sessionIds, options) => {
    const force = options?.force ?? false;
    const unique = Array.from(new Set(sessionIds)).filter(Boolean);
    const missing = unique.filter((sessionId) => {
      if (!force && get().loadingBySession[sessionId]) return false
      const cached = get().participantsBySession[sessionId]
      if (force) return true
      if (cached === undefined) return true
      // Retry an empty roster on every platform, not just extension/web. A
      // session always has at least its creator, so empty means something went
      // wrong (a cloud read that transiently returned nothing) rather than a
      // real answer — the retry costs nothing in practice and self-heals.
      if (cached.length === 0) return true
      return false
    });
    if (missing.length === 0) return;

    set((state) => ({
      loadingBySession: {
        ...state.loadingBySession,
        ...Object.fromEntries(missing.map((sessionId) => [sessionId, true])),
      },
      errorBySession: {
        ...state.errorBySession,
        ...Object.fromEntries(missing.map((sessionId) => [sessionId, null])),
      },
    }));

    await Promise.all(
      missing.map(async (sessionId) => {
        try {
          const participants = await loadParticipantInfo(sessionId);
          set((state) => ({
            participantsBySession: {
              ...state.participantsBySession,
              [sessionId]: participants,
            },
            loadingBySession: {
              ...state.loadingBySession,
              [sessionId]: false,
            },
          }));
        } catch (error) {
          set((state) => ({
            loadingBySession: {
              ...state.loadingBySession,
              [sessionId]: false,
            },
            errorBySession: {
              ...state.errorBySession,
              [sessionId]: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }),
    );
  },
  refreshSession: async (sessionId, teamId = null) => {
    set((state) => ({
      loadingBySession: {
        ...state.loadingBySession,
        [sessionId]: true,
      },
      errorBySession: {
        ...state.errorBySession,
        [sessionId]: null,
      },
    }));

    try {
      if (teamId) {
        await syncParticipantsForSession(sessionId, teamId, { full: true });
      }
      await get().ensureParticipants([sessionId], { force: true });
    } catch (error) {
      set((state) => ({
        loadingBySession: {
          ...state.loadingBySession,
          [sessionId]: false,
        },
        errorBySession: {
          ...state.errorBySession,
          [sessionId]: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  },
  setParticipants: (sessionId, participants) => {
    if (!sessionId) return;
    set((state) => {
      // Callers that resolve a roster without avatars (the sheet's Row shape
      // carries none) must not blank an avatar this store already knows.
      const known = new Map(
        (state.participantsBySession[sessionId] ?? []).map((p) => [p.actorId, p] as const),
      );
      // Externals this store already knows survive a roster that does not
      // mention them. The one publisher here besides the loaders is the actor
      // sheet, which manages team membership and filters its rows to
      // member/agent — so taking its list literally would drop the person on
      // the other end of a gateway chat out of the mention list the moment
      // someone opened the sheet.
      const incoming = new Set(participants.map((p) => p.actorId));
      const keptExternals = [...known.values()].filter(
        (p) => p.isExternal && !incoming.has(p.actorId),
      );
      return {
        participantsBySession: {
          ...state.participantsBySession,
          [sessionId]: [
            ...participants.map((p) => ({
              ...p,
              avatarUrl: p.avatarUrl ?? known.get(p.actorId)?.avatarUrl ?? null,
            })),
            ...keptExternals,
          ],
        },
        loadingBySession: { ...state.loadingBySession, [sessionId]: false },
        errorBySession: { ...state.errorBySession, [sessionId]: null },
      };
    });
  },
  invalidateSessions: (sessionIds) => {
    const ids = Array.from(new Set(sessionIds)).filter(Boolean);
    if (ids.length === 0) return;
    set((state) => ({
      loadingBySession: {
        ...state.loadingBySession,
        ...Object.fromEntries(ids.map((sessionId) => [sessionId, false])),
      },
      errorBySession: {
        ...state.errorBySession,
        ...Object.fromEntries(ids.map((sessionId) => [sessionId, null])),
      },
    }));
  },
}));
