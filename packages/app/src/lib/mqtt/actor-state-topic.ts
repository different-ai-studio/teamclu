/**
 * Prefix of the desktop's MQTT client id (`teamclu-<actor8>-<rand8>`,
 * `components/MqttLiveWiring.tsx`). An actor id is a UUID and never has it.
 *
 * Desktops before the fix used to register a retained JSON last-will on
 * `amux/{team}/{client_id}/state` — the actor-presence topic — so brokers hold
 * one undecodable retained message per past unclean disconnect, under a fake
 * "actor" segment carrying this prefix. Older desktops still in use keep
 * adding more until they update.
 */
const DESKTOP_CLIENT_ID_PREFIX = 'teamclu-'

/**
 * `amux/{team}/{actor}/state`, the one retained presence topic per actor.
 *
 * `null` for anything else, and for a segment that is a desktop client id
 * rather than an actor: those carry the legacy JSON will, not an
 * `ActorPresence`, and decoding them only produced a pair of "failed to decode
 * ActorPresence" warnings on every connect (one per subscriber store).
 */
export function parseActorStateTopic(
  topic: string,
): { teamId: string; actorId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'amux') return null
  if (parts[3] !== 'state') return null
  if (!parts[1] || !parts[2]) return null
  if (parts[2].startsWith(DESKTOP_CLIENT_ID_PREFIX)) return null
  return { teamId: parts[1], actorId: parts[2] }
}
