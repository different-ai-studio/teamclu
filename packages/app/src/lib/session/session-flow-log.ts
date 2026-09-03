type LogPayload = Record<string, unknown>;
type LogLevel = "info" | "warn" | "error";

export function summarizeText(
  value: string | null | undefined,
  maxPreviewLength = 120,
): { textLength: number; textPreview: string } {
  const normalized = (value ?? "").trim();
  const preview =
    normalized.length > maxPreviewLength
      ? `${normalized.slice(0, maxPreviewLength)}...`
      : normalized;
  return {
    textLength: normalized.length,
    textPreview: preview,
  };
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: typeof error,
    message: String(error),
  };
}

export function sessionFlowLog(
  stage: string,
  payload: LogPayload = {},
  level: LogLevel = "info",
): void {
  const record = {
    at: new Date().toISOString(),
    stage,
    ...payload,
  };
  console[level](`[session-flow] ${stage}`, record);
}

export function sessionFlowError(
  stage: string,
  error: unknown,
  payload: LogPayload = {},
): void {
  sessionFlowLog(
    stage,
    {
      ...payload,
      error: serializeError(error),
    },
    "error",
  );
}
