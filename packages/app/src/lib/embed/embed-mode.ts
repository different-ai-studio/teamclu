export function parseEmbedMode(search: string): 'chat' | null {
  const params = new URLSearchParams(search)
  return params.get('embed') === 'chat' ? 'chat' : null
}

export function resolveEmbedMode(
  search: string,
  forceEnv: string | undefined,
): 'chat' | null {
  if (forceEnv === 'chat') return 'chat'
  return parseEmbedMode(search)
}
