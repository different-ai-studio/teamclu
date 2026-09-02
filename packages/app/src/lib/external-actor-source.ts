import type { TFunction } from 'i18next'

/**
 * The gateways that create external actors. Each value is what
 * `crates/teamclu-gateway/*` passes as `source` to `ensure_external_actor`, so
 * this list is the client-side mirror of those call sites — keep them in step.
 */
const EXTERNAL_ACTOR_SOURCES = [
  'wecom',
  'wechat',
  'feishu',
  'discord',
  'kook',
  'seatalk',
  'email',
] as const

type ExternalActorSource = (typeof EXTERNAL_ACTOR_SOURCES)[number]

function isKnownExternalSource(source: string | null | undefined): source is ExternalActorSource {
  return !!source && (EXTERNAL_ACTOR_SOURCES as readonly string[]).includes(source)
}

/**
 * Human name for a gateway. An unrecognised source is shown verbatim rather
 * than as a placeholder: a channel added server-side before the client knows
 * about it is still more useful spelled out than as "Unknown".
 */
export function externalSourceLabel(
  source: string | null | undefined,
  t: TFunction,
): string {
  if (!source) return t('actors.source.unknown', 'Unknown')
  if (isKnownExternalSource(source)) return t(`actors.source.${source}`, source)
  return source
}
