/** True when an OS/Tauri drop should attach to chat instead of copying into the workspace. */
export function isChatInputDropTarget(el: Element | null | undefined): boolean {
  return Boolean(el?.closest('[data-testid="chat-input-area"]'))
}

export function isPointOverElement(
  position: { x: number; y: number },
  el: Element | null | undefined,
): boolean {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  return (
    position.x >= rect.left &&
    position.x <= rect.right &&
    position.y >= rect.top &&
    position.y <= rect.bottom
  )
}
