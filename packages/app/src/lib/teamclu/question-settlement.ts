import type { Question } from "@/stores/session-types";

/**
 * Trailer the pi question tool appends to its result text so a client that
 * missed the live `question_replied` event can still show who answered.
 * Must match `SETTLED_MARKER` in `apps/daemon/assets/pi-extension/teamclu.ts`.
 */
export const QUESTION_SETTLED_MARKER = "teamclu.question.settled=";

export interface QuestionSettlement {
  answeredBy: string;
  /** One array of selected labels per question, in order. */
  answers: string[][];
  rejected: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function answerRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    if (Array.isArray(row)) return row.map((label) => String(label));
    if (row == null) return [];
    return [String(row)];
  });
}

/** Decode the JSON body shared by the live event and the tool-result trailer. */
export function parseQuestionSettlementBody(value: unknown): QuestionSettlement | null {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.answers)) return null;
  return {
    answeredBy: typeof body.answeredBy === "string" ? body.answeredBy : "",
    answers: answerRows(body.answers),
    rejected: body.rejected === true,
  };
}

/** Pull a settlement out of a completed question tool's result text. */
export function parseQuestionSettlementResult(result: unknown): QuestionSettlement | null {
  if (typeof result !== "string" || !result.includes(QUESTION_SETTLED_MARKER)) return null;
  const line = result
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith(QUESTION_SETTLED_MARKER));
  if (!line) return null;
  try {
    return parseQuestionSettlementBody(JSON.parse(line.slice(QUESTION_SETTLED_MARKER.length)));
  } catch {
    return null;
  }
}

/**
 * Key ordered answers the way QuestionCard looks them up: the question id
 * when it has one, and the index string either way.
 */
export function answersRecordFromOrdered(
  questions: ReadonlyArray<Pick<Question, "id">>,
  ordered: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  ordered.forEach((labels, index) => {
    const text = labels.map((label) => label.trim()).filter(Boolean).join(", ");
    if (!text) return;
    const id = questions[index]?.id || String(index);
    out[id] = text;
    out[String(index)] = text;
  });
  return out;
}

/**
 * Prefer a directory/participant name. A short unmatched string is already a
 * display name (a chat answer). A long unmatched id is shortened.
 */
export function answererLabel(
  answeredBy: string | undefined,
  knownNames: ReadonlyArray<{ id: string; name: string }>,
): string {
  const raw = answeredBy?.trim() ?? "";
  if (!raw) return "";
  const known = knownNames.find((entry) => entry.id === raw)?.name.trim();
  if (known) return known;
  return raw.length > 24 ? raw.slice(0, 8) : raw;
}
