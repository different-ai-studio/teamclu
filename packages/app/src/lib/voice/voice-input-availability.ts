interface VoiceInputAvailability {
  hasSession: boolean;
  installed: boolean;
  installing: boolean;
  recordingElsewhere: boolean;
  supported: boolean;
}

export function isVoiceInputMainDisabled({
  hasSession,
  installed,
  installing,
  recordingElsewhere,
  supported,
}: VoiceInputAvailability): boolean {
  return installing || recordingElsewhere || !supported || (!hasSession && installed);
}
