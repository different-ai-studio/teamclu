import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import {
  useVoiceInputStore,
  type VoiceInputStatus,
} from "@/stores/voice-input";
import type { VoiceModelVariant } from "./voice-models";

export interface VoiceSegment {
  recordingId: string;
  segmentId: string;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Session-local diarizer label; absent until CAM++ speaker resolution is enabled. */
  speakerClusterId?: string | null;
  /** Reserved for enrolled voiceprint identity. Never populated in phase one. */
  speakerProfileId?: string | null;
}

export type VoiceRoute =
  | { mode: "silent" }
  | { mode: "trigger"; agent: AttachedAgent };

interface RecordingHandler {
  route: VoiceRoute;
  sessionId: string;
  queue: Promise<void>;
  onSegment: (segment: VoiceSegment, sessionId: string, route: VoiceRoute) => Promise<void>;
}

const handlers = new Map<string, RecordingHandler>();
let eventSetup: Promise<void> | null = null;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(command, args);
}

async function setupEvents(): Promise<void> {
  if (eventSetup) return eventSetup;
  eventSetup = (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<VoiceSegment>("voice:segment", ({ payload }) => {
      const handler = handlers.get(payload.recordingId);
      if (!handler) return;
      handler.queue = handler.queue
        .then(() => handler.onSegment(payload, handler.sessionId, handler.route))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          useVoiceInputStore.getState().setError(message);
        });
    });
    await listen<{ recordingId: string }>("voice:stopped", ({ payload }) => {
      handlers.delete(payload.recordingId);
      const store = useVoiceInputStore.getState();
      if (store.recordingId === payload.recordingId) {
        store.setRecording(null);
        if (store.status) store.setStatus({ ...store.status, listening: false });
      }
    });
    await listen<{ rms: number; elapsedMs: number }>("voice:level", ({ payload }) => {
      useVoiceInputStore.getState().setLevel(payload.rms, payload.elapsedMs);
    });
    await listen<{ bytesDownloaded: number; totalBytes: number }>(
      "voice:install-progress",
      ({ payload }) => {
        useVoiceInputStore
          .getState()
          .setInstallProgress(payload.totalBytes > 0 ? payload.bytesDownloaded / payload.totalBytes : 0);
      },
    );
    await listen("voice:install-finished", () => {
      useVoiceInputStore.getState().setInstallProgress(1);
      void refreshVoiceInputStatus();
    });
    await listen<{ message?: string }>("voice:error", ({ payload }) => {
      useVoiceInputStore.getState().setError(payload.message || "Voice input failed");
      void refreshVoiceInputStatus();
    });
  })();
  return eventSetup;
}

export async function refreshVoiceInputStatus(): Promise<VoiceInputStatus> {
  await setupEvents();
  const status = await invoke<VoiceInputStatus>("voice_input_status");
  useVoiceInputStore.getState().setStatus(status);
  return status;
}

export async function installLocalVoiceInput(modelVariant: VoiceModelVariant): Promise<void> {
  await setupEvents();
  const store = useVoiceInputStore.getState();
  store.setError(null);
  store.setInstallProgress(0);
  await invoke("voice_input_install", { modelVariant });
  if (store.status) store.setStatus({ ...store.status, installing: true });
}

export async function startLocalVoiceInput(input: {
  sessionId: string;
  workspacePath: string;
  route: VoiceRoute;
  onSegment: RecordingHandler["onSegment"];
}): Promise<void> {
  await setupEvents();
  const recordingId = crypto.randomUUID();
  handlers.set(recordingId, { ...input, queue: Promise.resolve() });
  const store = useVoiceInputStore.getState();
  store.setError(null);
  store.setRecording(
    recordingId,
    input.sessionId,
    input.route.mode === "trigger" ? input.route.agent.displayName : null,
  );
  try {
    await invoke("voice_input_start", {
      recordingId,
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      speakerDiarization: input.route.mode === "silent",
    });
    if (store.status) store.setStatus({ ...store.status, listening: true });
  } catch (error) {
    handlers.delete(recordingId);
    store.setRecording(null);
    throw error;
  }
}

export async function stopLocalVoiceInput(): Promise<void> {
  await invoke("voice_input_stop");
}
