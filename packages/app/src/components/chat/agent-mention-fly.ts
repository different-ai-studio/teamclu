/** Visual only: a name chip travels from the caret to the pill that already
 * represents the engaged agent. It does not attach, remove, or route anyone. */

let activeFlyer: HTMLElement | null = null

function clearFlyer() {
  activeFlyer?.remove()
  activeFlyer = null
}

export function playAgentMentionFly(args: {
  name: string
  from: DOMRect | null
  dock: HTMLElement | null
  agentId: string
}) {
  const findPill = () =>
    args.dock?.querySelector<HTMLElement>(
      `[data-agent-pill="${CSS.escape(args.agentId)}"]`,
    ) ?? null

  const pulse = () => {
    const pill = findPill()
    if (!pill) return
    pill.classList.remove("agent-mention-settle")
    void pill.offsetWidth
    pill.classList.add("agent-mention-settle")
    pill.addEventListener(
      "animationend",
      () => pill.classList.remove("agent-mention-settle"),
      { once: true },
    )
  }

  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  if (reduce || !args.from) {
    window.requestAnimationFrame(pulse)
    return
  }

  clearFlyer()
  const flyer = document.createElement("span")
  flyer.className = "agent-mention-flyer"
  flyer.textContent = args.name
  flyer.setAttribute("aria-hidden", "true")
  const startX = args.from.left
  const startY = args.from.top
  flyer.style.transition = "none"
  flyer.style.transform = `translate(${startX}px, ${startY}px)`
  document.body.appendChild(flyer)
  activeFlyer = flyer
  flyer.getBoundingClientRect()

  let attempts = 0
  let landed = false
  const finish = (pill: HTMLElement | null) => {
    if (landed) return
    landed = true
    if (activeFlyer === flyer) activeFlyer = null
    flyer.remove()
    if (pill) {
      pill.classList.remove("agent-mention-settle")
      void pill.offsetWidth
      pill.classList.add("agent-mention-settle")
      pill.addEventListener(
        "animationend",
        () => pill.classList.remove("agent-mention-settle"),
        { once: true },
      )
    }
  }

  const launch = () => {
    const pill = findPill()
    if (!pill && attempts < 8) {
      attempts += 1
      window.requestAnimationFrame(launch)
      return
    }
    const to = pill?.getBoundingClientRect()
    const endX = to?.left ?? startX
    const endY = to?.top ?? startY
    flyer.style.transition = ""
    flyer.addEventListener("transitionend", () => finish(pill), { once: true })
    window.setTimeout(() => finish(findPill()), 700)
    window.requestAnimationFrame(() => {
      flyer.style.transform = `translate(${endX}px, ${endY}px)`
    })
  }
  window.requestAnimationFrame(launch)
}
