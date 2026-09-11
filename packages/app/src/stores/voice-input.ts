import { create } from "zustand";
import type { VoiceModelVariant } from "@/lib/voice/voice-models";

export type VoiceInputMode = "silent" | "trigger";

export interface VoiceInputStatus {
  supported: boolean;
  installed: boolean;
  installing: boolean;
  listening: boolean;
  engineVersion: string;
  installedModel?: VoiceModelVariant | null;
  reason?: string | null;
}

const MODE_KEY = "teamclu-voice-input-mode";

function initialMode(): VoiceInputMode | null {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === "silent" || value === "trigger" ? value : null;
  } catch {
    return null;
  }
}

interface VoiceInputStore {
  status: VoiceInputStatus | null;
  mode: VoiceInputMode | null;
  recordingId: string | null;
  recordingSessionId: string | null;
  targetAgentName: string | null;
  elapsedMs: number;
  level: number;
  installProgress: number;
  error: string | null;
  setStatus: (status: VoiceInputStatus) => void;
  setMode: (mode: VoiceInputMode) => void;
  setRecording: (
    recordingId: string | null,
    recordingSessionId?: string | null,
    targetAgentName?: string | null,
  ) => void;
  setLevel: (level: number, elapsedMs: number) => void;
  setInstallProgress: (progress: number) => void;
  setError: (error: string | null) => void;
}

export const useVoiceInputStore = create<VoiceInputStore>((set) => ({
  status: null,
  mode: initialMode(),
  recordingId: null,
  recordingSessionId: null,
  targetAgentName: null,
  elapsedMs: 0,
  level: 0,
  installProgress: 0,
  error: null,
  setStatus: (status) => set({ status }),
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Preference persistence is best effort.
    }
    set({ mode });
  },
  setRecording: (recordingId, recordingSessionId = null, targetAgentName = null) =>
    set({
      recordingId,
      recordingSessionId,
      targetAgentName,
      elapsedMs: 0,
      level: 0,
    }),
  setLevel: (level, elapsedMs) => set({ level, elapsedMs }),
  setInstallProgress: (installProgress) => set({ installProgress }),
  setError: (error) => set({ error }),
}));
