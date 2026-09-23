import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";

import {
  DICTATION_CONTEXTUAL_STRINGS,
  dictationLanguage,
  normalizeSpeechVolume,
} from "../voice-level";

export type VoiceRecorder = {
  isRecording: boolean;
  durationMs: number;
  /** Normalised 0…1 input level, for the recording waveform. */
  level: number;
  /** What has been recognised so far in this take. */
  transcript: string;
  start: () => Promise<void>;
  /** Stops listening and resolves with the final transcript ("" if nothing was heard). */
  stop: () => Promise<string>;
};

/** How long `stop()` waits for the recognizer's final result before giving up on it. */
const FINAL_RESULT_TIMEOUT_MS = 3_000;

function deviceLanguage(): string {
  try {
    // Lazy so vitest never loads the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Localization = require("expo-localization") as {
      getLocales?: () => Array<{ languageTag?: string | null }>;
    };
    return dictationLanguage(Localization.getLocales?.()[0]?.languageTag);
  } catch {
    return "en-US";
  }
}

/**
 * Speech-to-text into the composer — iOS `VoiceRecorder` (on-device
 * `SFSpeechRecognizer`). This used to record an audio file and paste its
 * device-local `file://` path into the message, which reached everyone else as
 * a path they could not open.
 */
export function useVoiceRecorder(): VoiceRecorder {
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const transcriptRef = useRef("");
  const pendingStop = useRef<((text: string) => void) | null>(null);

  const settle = () => {
    setIsRecording(false);
    setStartedAt(null);
    setLevel(0);
    const resolve = pendingStop.current;
    pendingStop.current = null;
    resolve?.(transcriptRef.current.trim());
  };

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results[0]?.transcript;
    if (text === undefined) return;
    transcriptRef.current = text;
    setTranscript(text);
  });
  useSpeechRecognitionEvent("volumechange", (event) => {
    setLevel(normalizeSpeechVolume(event.value));
  });
  useSpeechRecognitionEvent("end", settle);
  useSpeechRecognitionEvent("error", settle);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(() => () => {
    // Leaving the screen mid-take: stop listening, drop the result.
    if (pendingStop.current === null) ExpoSpeechRecognitionModule.abort();
  }, []);

  return {
    isRecording,
    durationMs: startedAt === null ? 0 : Math.max(0, now - startedAt),
    level,
    transcript,
    async start() {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Microphone or speech recognition permission denied.");
      }
      transcriptRef.current = "";
      setTranscript("");
      ExpoSpeechRecognitionModule.start({
        lang: deviceLanguage(),
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        contextualStrings: DICTATION_CONTEXTUAL_STRINGS,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      });
      const started = Date.now();
      setStartedAt(started);
      setNow(started);
      setIsRecording(true);
    },
    stop() {
      if (!isRecording) return Promise.resolve(transcriptRef.current.trim());
      return new Promise<string>((resolve) => {
        pendingStop.current = resolve;
        // iOS delivers the final transcript only after stop; `end` settles it.
        ExpoSpeechRecognitionModule.stop();
        setTimeout(() => {
          if (pendingStop.current === resolve) settle();
        }, FINAL_RESULT_TIMEOUT_MS);
      });
    },
  };
}
