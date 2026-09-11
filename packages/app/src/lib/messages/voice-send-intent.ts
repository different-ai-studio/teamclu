import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

export type VoiceSendIntent =
  | { kind: "voice-silent"; segmentId: string }
  | { kind: "voice-trigger"; segmentId: string; agent: AttachedAgent };

export function resolveVoiceSendAgent(
  intent: VoiceSendIntent | undefined,
  normalCandidate: AttachedAgent | null,
): AttachedAgent | null {
  if (intent?.kind === "voice-silent") return null;
  if (intent?.kind === "voice-trigger") return intent.agent;
  return normalCandidate;
}

/**
 * Voice segments are standalone messages. They must never consume a typed
 * draft or attachments that happened to be waiting in the composer.
 */
export function composerPayloadForSend<T>(
  pendingFiles: T[],
  intent?: VoiceSendIntent,
): { files: T[]; clearComposer: boolean } {
  return intent
    ? { files: [], clearComposer: false }
    : { files: pendingFiles, clearComposer: true };
}
