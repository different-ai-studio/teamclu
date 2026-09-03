interface MqttConnectionKeyInput {
  userId: string | null;
  teamId: string | null;
  accessToken: string | null;
}

export function mqttConnectionKey(input: MqttConnectionKeyInput): string | null {
  if (!input.userId || !input.teamId || !input.accessToken) return null;
  return `${input.userId}:${input.teamId}:${input.accessToken}`;
}
