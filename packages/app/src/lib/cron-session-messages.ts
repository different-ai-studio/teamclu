/**
 * Load cron (and other cloud-backed) session messages into the v2 message store.
 * Used when navigating from Cron run history so the chat pane does not wait on
 * libsql sync / refresh-trigger quirks.
 */
import { create as createMessage } from "@bufbuild/protobuf";
import i18n from "@/lib/i18n";
import { getBackend } from "@/lib/backend";
import type { MessageHistoryRow } from "@/lib/backend/types";
import { MessageKind, MessageSchema, type Message } from "@/lib/proto/teamclu_pb";
import { isTauri } from "@/lib/utils";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useCurrentTeamStore } from "@/stores/current-team";

/**
 * Make a cron-run session show up in the sidebar session list immediately,
 * without waiting for the next paginated `session-list-store` reload. Used
 * both when jumping to a session from run history and right after "Run Now"
 * creates one — the list otherwise only picks the row up on its own poll.
 */
export async function ensureCronSessionVisible(sessionId: string): Promise<void> {
  // A cron session belongs to the team you are in. This used to look the team
  // up from the session id and then `enterTeam` into whatever came back, which
  // meant a cron surface could yank you into another team's session; a run
  // history should only ever show its own team's runs. Scoping to the current
  // team makes a foreign session id simply "not found".
  const teamId = useCurrentTeamStore.getState().team?.id ?? null;
  if (!teamId) {
    throw new Error(
      i18n.t("settings.cron.sessionNotFound", { id: sessionId.slice(0, 8) }),
    );
  }

  // Skip upsert if already in list (may have been added by a previous call)
  if (useSessionListStore.getState().rows.some((row) => row.id === sessionId)) return;

  // One team-scoped request doing double duty: it fetches the title AND proves
  // the session is ours — display-rows is filtered by team, so a session from
  // another team comes back empty. (This replaced a getSessionTeamId call that
  // ran ahead of it purely to "verify access", so this is one request fewer.)
  const [displayRow] = await getBackend().sessions.listSessionDisplayRows(teamId, [sessionId]);
  if (!displayRow) {
    throw new Error(
      i18n.t("settings.cron.sessionNotFound", { id: sessionId.slice(0, 8) }),
    );
  }
  useSessionListStore.getState().upsertRows([
    {
      id: sessionId,
      title: displayRow?.title || "Cron job",
      team_id: teamId,
      last_message_at: null,
      last_message_preview: null,
      mode: "collab",
      idea_id: null,
      has_unread: false,
      // Origin marker. Every caller of this function is a cron surface ("Run
      // Now", run history's 查看对话), and the row we synthesise here is what
      // the sidebar filters on until the next paginated reload replaces it.
      // Without it the row reads as source=undefined, i.e. an ordinary chat:
      // it lands in the 会话 list and is filtered OUT of the clock (定时任务)
      // view — the opposite of both call sites' intent.
      source: "cron",
      created_at: null,
      updated_at: null,
    },
  ]);
}

const KIND_MAP: Record<string, MessageKind> = {
  text: MessageKind.TEXT,
  system: MessageKind.SYSTEM,
  agent_thinking: MessageKind.AGENT_THINKING,
  agent_tool_call: MessageKind.AGENT_TOOL_CALL,
  agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
  agent_reply: MessageKind.AGENT_REPLY,
};

function historyRowToProto(row: MessageHistoryRow): Message {
  return createMessage(MessageSchema, {
    messageId: row.id,
    sessionId: row.session_id,
    senderActorId: row.sender_actor_id ?? "",
    kind: KIND_MAP[row.kind] ?? MessageKind.TEXT,
    content: row.content ?? "",
    model: row.model ?? "",
    turnId: row.turn_id ?? "",
    createdAt: BigInt(Math.floor(new Date(row.created_at).getTime() / 1000)),
  });
}

function fallbackSummaryMessage(
  sessionId: string,
  summary: string,
  runId?: string,
): Message {
  const id = runId ? `cron-summary-${runId}` : `cron-summary-${sessionId}`;
  return createMessage(MessageSchema, {
    messageId: id,
    sessionId,
    senderActorId: "",
    kind: MessageKind.AGENT_REPLY,
    content: summary,
    model: "",
    turnId: "",
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
  });
}

type HydrateCronSessionMessagesOpts = {
  /** When Cloud has no rows yet, show this text so the run is not a blank thread. */
  fallbackSummary?: string | null;
  runId?: string;
  /** Warm libsql cache after painting from Cloud (desktop only). */
  syncCache?: boolean;
};

/**
 * Pull messages from Cloud into `useSessionMessageStore`, optionally seeding a
 * one-off agent bubble from the cron run record when the backend is still empty.
 *
 * @returns number of messages now in the store for this session
 */
export async function hydrateCronSessionMessages(
  sessionId: string,
  opts?: HydrateCronSessionMessagesOpts,
): Promise<number> {
  let rows: MessageHistoryRow[] = [];
  try {
    rows = (await getBackend().messages.listMessages(sessionId)).rows;
  } catch (error) {
    console.warn(
      "[cron-session] cloud listMessages failed:",
      error instanceof Error ? error.message : error,
    );
  }

  let protos: Message[];
  if (rows.length > 0) {
    protos = rows.map(historyRowToProto);
  } else {
    const summary = opts?.fallbackSummary?.trim();
    if (!summary) {
      useSessionMessageStore.getState().setMessages(sessionId, []);
      return 0;
    }
    protos = [fallbackSummaryMessage(sessionId, summary, opts?.runId)];
  }

  useSessionMessageStore.getState().setMessages(sessionId, protos);

  if (opts?.syncCache !== false && isTauri() && rows.length > 0) {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id ?? null;
      if (teamId) {
        await syncMessagesForSession(sessionId, teamId, { full: true });
        const { loadMessagesForSession } = await import("@/lib/local-cache");
        const fresh = await loadMessagesForSession(sessionId, false);
        if (fresh.length > 0) {
          useSessionMessageStore.getState().setMessages(
            sessionId,
            fresh.map((r) =>
              createMessage(MessageSchema, {
                messageId: r.id,
                sessionId: r.sessionId,
                senderActorId: r.senderActorId ?? "",
                kind: KIND_MAP[r.kind] ?? MessageKind.TEXT,
                content: r.content ?? "",
                model: r.model ?? "",
                turnId: r.turnId ?? "",
                createdAt: BigInt(Math.floor(new Date(r.createdAt).getTime() / 1000)),
              }),
            ),
          );
        }
      }
    } catch (error) {
      console.warn(
        "[cron-session] cache sync failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return protos.length;
}
