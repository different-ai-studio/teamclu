/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time locale selection: 'en' | 'zh-CN' | 'all' | undefined */
  readonly VITE_LOCALE?: string;
  readonly VITE_CLOUD_API_URL?: string;
  readonly VITE_MQTT_HOST?: string;
  readonly VITE_MQTT_PORT?: string;
  readonly VITE_MQTT_USE_TLS?: string;
  readonly VITE_MQTT_USERNAME?: string;
  readonly VITE_MQTT_PASSWORD?: string;
  /** Set by scripts/tauri-cli.js for `pnpm tauri:dev -- --skip-setup`. */
  readonly VITE_TEAMCLU_SKIP_SETUP?: string;
  /** Set by scripts/tauri-cli.js for `pnpm tauri:dev -- --skip-daemon-onboarding`. */
  readonly VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING?: string;
  /** E2E build: installs the window.__TEAMCLU_V2_E2E__ control surface. */
  readonly VITE_TEAMCLU_E2E?: string;
  /** Extension embed build: force chat-only shell (apps/extension/build.mjs). */
  readonly VITE_FORCE_EMBED?: string;
  /** '1' opts a dev run back into Sentry reporting, which is off by default. */
  readonly VITE_SENTRY_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_CONFIG__: import('@/lib/config/build-config').BuildConfig | undefined
/** Fully normalized extension pack, including the `extension` branding alias. */
declare const __TEAMCLU_EXTENSION_PACK__: unknown | undefined
/** Baked `extensions.settings` from build.config*.json (Vite + extension content-script). */
declare const __TEAMCLU_EXTENSION_SETTINGS__: unknown | undefined

declare module '*.css' {
  const content: string
  export default content
}

// Web Speech API (SpeechRecognition) - not in standard lib.dom.d.ts
interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}
declare let SpeechRecognition: { new (): SpeechRecognitionInstance };
declare let webkitSpeechRecognition: { new (): SpeechRecognitionInstance };
interface Window {
  SpeechRecognition?: typeof SpeechRecognition;
  webkitSpeechRecognition?: typeof webkitSpeechRecognition;
}
