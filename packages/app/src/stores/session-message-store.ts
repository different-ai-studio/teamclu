import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclu_pb";
import { MessageKind } from "@/lib/proto/teamclu_pb";
import { useSessionSelectionStore } from "./session-selection-store";
import {
  mergeTurnAgentReplyProto,
  protoPartsJson,
} from "@/lib/messages/merge-turn-agent-reply";

const EMPTY_MESSAGES: Message[] = [];

/** `createdAt` is whole seconds, so a gateway user message and the agent reply
 * written right after it routinely land in the same second. Do NOT tiebreak on
 * `messageId`: a WeCom `msgid` vs. a random reply UUID compares arbitrarily and
 * flips the pair. Ties fall back to the caller's order instead — `Array#sort`
 * is stable and the insert below lands after equals, so server list order and
 * MQTT arrival order (both correct) survive. */
function compareProtoMessages(a: Message, b: Message): number {
  const ta = Number(a.createdAt) || 0;
  const tb = Number(b.createdAt) || 0;
  return ta - tb;
}

function insertProtoMessageSorted(messages: Message[], message: Message): Message[] {
  if (messages.some((row) => row.messageId === message.messageId)) {
    return messages;
  }
  if (messages.length === 0) return [message];
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // upper bound: a same-second message is appended after its peers, not before
    if (compareProtoMessages(messages[mid], message) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return [...messages.slice(0, lo), message, ...messages.slice(lo)];
}

type SessionMessageState = {
  messages: Record<string, Message[]>;
  messageRefreshTrigger: number;
  /** When true, the next App.tsx history load uses a full cloud/cache sync. */
  messageRefreshForceFull: boolean;
  appendMessage: (sessionId: string, message: Message) => void;
  /** One synthesized AGENT_REPLY per turn in the in-memory list (daemon may emit many). */
  replaceTurnAgentRepliesInStore: (sessionId: string, message: Message) => void;
  removeMessageById: (sessionId: string, messageId: string) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  currentMessages: () => Message[];
  reloadActiveSessionMessages: (opts?: { full?: boolean }) => Promise<void>;
};

export const useSessionMessageStore = create<SessionMessageState>((set, get) => ({
  messages: {},
  messageRefreshTrigger: 0,
  messageRefreshForceFull: false,
  appendMessage: (sessionId, message) => {
    const cur = get().messages[sessionId] ?? [];
    if (cur.some((m) => m.messageId === message.messageId)) return;
    set({ messages: { ...get().messages, [sessionId]: [...cur, message] } });
  },
  replaceTurnAgentRepliesInStore: (sessionId, message) => {
    const turnId = message.turnId?.trim();
    const senderActorId = message.senderActorId?.trim();
    const cur = get().messages[sessionId] ?? [];
    if (!turnId || !senderActorId || message.kind !== MessageKind.AGENT_REPLY) {
      get().appendMessage(sessionId, message);
      return;
    }
    const existingInTurn = cur.filter(
      (row) =>
        row.turnId === turnId &&
        row.senderActorId === senderActorId &&
        row.kind === MessageKind.AGENT_REPLY,
    );
    const rest = cur.filter((row) => !existingInTurn.includes(row));
    const prior =
      existingInTurn.find((row) => protoPartsJson(row).length > 0) ??
      existingInTurn[existingInTurn.length - 1];
    const merged =
      prior != null ? mergeTurnAgentReplyProto(prior, message) : message;
    const withoutSameId = rest.filter((row) => row.messageId !== merged.messageId);
    set({
      messages: {
        ...get().messages,
        [sessionId]: insertProtoMessageSorted(withoutSameId, merged),
      },
    });
  },
  removeMessageById: (sessionId, messageId) => {
    const trimmed = messageId.trim();
    if (!trimmed) return;
    const cur = get().messages[sessionId] ?? [];
    const next = cur.filter((row) => row.messageId !== trimmed);
    if (next.length === cur.length) return;
    set({ messages: { ...get().messages, [sessionId]: next } });
  },
  setMessages: (sessionId, messages) => {
    set({ messages: { ...get().messages, [sessionId]: messages } });
  },
  currentMessages: () => {
    const sessionId = useSessionSelectionStore.getState().currentSessionId;
    if (!sessionId) return EMPTY_MESSAGES;
    return get().messages[sessionId] ?? EMPTY_MESSAGES;
  },
  reloadActiveSessionMessages: async (opts) => {
    set({
      messageRefreshTrigger: get().messageRefreshTrigger + 1,
      messageRefreshForceFull: opts?.full ?? false,
    });
  },
}));
