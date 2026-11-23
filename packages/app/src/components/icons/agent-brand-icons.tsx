/**
 * Brand mark for the local-agent runtime (pi, the only runtime — ADR-0014).
 * Uses `currentColor` so it renders as a white glyph inside the coral chip
 * container in the sidebar, exactly like the lucide icons it replaces.
 *
 * Hand-drawn on a 28×28 grid sampled from the reference PNG
 * (Downloads/pi-agent-logo.png).
 */

/** pi-agent: the pixel "Pi" mark — head with a square counter plus the dotted stem. */
export function PiAgentMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M6 6h4v16H6zM10 6h8v4h-8zM14 10h4v4h-4zM10 14h4v4h-4zM18 14h4v8h-4z" />
    </svg>
  )
}
