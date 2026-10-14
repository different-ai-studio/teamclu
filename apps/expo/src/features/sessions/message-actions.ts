import { foldForSearch } from "../search/search-matcher";
import { mentionPlainText } from "./mention-display";
import type { SessionFeedSource } from "./session-feed-items";
import type { SessionMessage } from "./session-types";

/**
 * Feed-level helpers behind search, multi-select and "ask again" (iOS #1709
 * stage three). Everything here works on what the reader sees: a chat
 * message, or a finished agent reply — never thinking or tool steps.
 */

const CHAT_KINDS = new Set(["text"]);

function isChatMessage(message: SessionMessage): boolean {
  return CHAT_KINDS.has(message.kind.trim().toLowerCase());
}

/** The message a row shows and can copy, forward or search; null otherwise. */
export function selectableMessage(source: SessionFeedSource): SessionMessage | null {
  if (source.kind === "message") return isChatMessage(source.message) ? source.message : null;
  return source.turn.isActive ? null : source.turn.finalMessage ?? null;
}

/** Text as displayed: mention tokens rendered as their names. */
export function displayText(message: SessionMessage): string {
  return mentionPlainText(message.content);
}

/** Case- and diacritic-insensitive substring match on displayed text. */
export function textMatches(text: string, query: string): boolean {
  const needle = foldForSearch(query);
  return needle.length > 0 && foldForSearch(text).includes(needle);
}

/** Feed rows whose visible text contains `query`, in feed order. */
export function feedSearchMatches(
  sources: readonly SessionFeedSource[],
  query: string,
): string[] {
  if (foldForSearch(query).length === 0) return [];
  const keys: string[] = [];
  for (const source of sources) {
    const message = selectableMessage(source);
    if (message && textMatches(displayText(message), query)) keys.push(source.key);
  }
  return keys;
}

/**
 * The prompt behind agent turn `turnKey`: the nearest chat message above it.
 * Null when there is none, or when it carried files — resending only its text
 * would ask a different question.
 */
export function promptForTurn(
  sources: readonly SessionFeedSource[],
  turnKey: string,
): SessionMessage | null {
  const index = sources.findIndex((source) => source.key === turnKey);
  if (index < 0 || sources[index]!.kind !== "agentTurn") return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const source = sources[i]!;
    if (source.kind !== "message" || !isChatMessage(source.message)) continue;
    const prompt = source.message;
    if ((prompt.attachments?.length ?? 0) > 0 || prompt.content.trim().length === 0) return null;
    return prompt;
  }
  return null;
}

/**
 * Selected messages as plain text for the clipboard or a forward: one
 * "Sender: text" block per message, oldest first, with an optional header
 * ("Forwarded from …"). A forward is an ordinary message, so every client
 * reads it without knowing it was forwarded.
 */
export function composeTranscript(
  messages: ReadonlyArray<{ sender: string; text: string }>,
  header?: string | null,
): string {
  const body = messages.map((m) => `${m.sender}: ${m.text}`).join("\n\n");
  return header ? `${header}\n\n${body}` : body;
}

/**
 * Selection in feed order, as messages. Delete is offered only when every one
 * is the reader's own and already on the server (no outbox row still sending).
 */
export function selectedMessages(
  sources: readonly SessionFeedSource[],
  selectedKeys: ReadonlySet<string>,
): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const source of sources) {
    if (!selectedKeys.has(source.key)) continue;
    const message = selectableMessage(source);
    if (message) out.push(message);
  }
  return out;
}

export function canDeleteSelection(
  messages: readonly SessionMessage[],
  ownActorId: string | null | undefined,
  isPersisted: (messageId: string) => boolean,
): boolean {
  return (
    messages.length > 0 &&
    Boolean(ownActorId) &&
    messages.every((m) => m.senderActorId === ownActorId && isPersisted(m.messageId))
  );
}

/** iOS searches message bodies from two characters on. */
export const MESSAGE_SEARCH_MIN_LENGTH = 2;

/** Sessions with at least one cached message whose displayed text matches. */
export function sessionIdsMatchingMessages(
  rows: ReadonlyArray<{ sessionId: string; content: string }>,
  query: string,
): Set<string> {
  const out = new Set<string>();
  if (foldForSearch(query).length < MESSAGE_SEARCH_MIN_LENGTH) return out;
  for (const row of rows) {
    if (out.has(row.sessionId)) continue;
    if (textMatches(mentionPlainText(row.content), query)) out.add(row.sessionId);
  }
  return out;
}
