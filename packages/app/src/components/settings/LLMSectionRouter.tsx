import * as React from 'react'
import { getDaemonLocalAgent, type DaemonLocalAgent } from '@/lib/daemon/daemon-local-client'
import { isTauri } from '@/lib/utils'
import { OpenCodeLLMSection } from './LLMSection'
import { PiLLMSection } from './PiLLMSection'
import { CursorLLMSection } from './CursorLLMSection'
import { ClaudeLLMSection } from './ClaudeLLMSection'
import { AgentModelDefaults } from './llm/AgentModelDefaults'

/**
 * LLM settings dispatcher. The local agent runtime determines both the logic
 * and the layout: opencode configures providers via opencode.json / opencode
 * serve (connect, OAuth, custom providers); pi owns its own credentials on the
 * host (`pi /login`) and only exposes a read-only model catalog. We branch on
 * `agents.local_agent` so each runtime gets its own pane.
 *
 * pi, cursor and claude-code all own their credentials outside opencode.json, so
 * their panes are read-only catalogs; only opencode gets the provider UI.
 *
 * The pinned team-gateway card (`TeamProviderCard`) lives in the opencode and pi
 * panes only. cursor and claude-code drive their own vendor accounts and offer
 * no hook for pointing a session at our gateway, so the team tiers are not
 * available there and the card is deliberately absent rather than shown broken.
 */
export function LLMSection() {
  const [agent, setAgent] = React.useState<DaemonLocalAgent | null>(null)

  React.useEffect(() => {
    let alive = true
    if (!isTauri()) {
      setAgent('opencode')
      return
    }
    void getDaemonLocalAgent()
      .then((a) => {
        if (alive) setAgent(a)
      })
      .catch(() => {
        if (alive) setAgent('opencode')
      })
    return () => {
      alive = false
    }
  }, [])

  // Until the runtime is known, render nothing to avoid flashing the wrong pane.
  if (agent === null) return null

  // The defaults block sits above the runtime pane and is the same for all four:
  // "which model does each surface run on" is a property of the device, not of
  // which agent happens to be configured. Rendering it here rather than inside
  // each pane is what keeps it from drifting into four copies.
  return (
    <>
      <AgentModelDefaults />
      {agent === 'pi' ? (
        <PiLLMSection />
      ) : agent === 'cursor' ? (
        <CursorLLMSection />
      ) : agent === 'claude-code' ? (
        <ClaudeLLMSection />
      ) : (
        <OpenCodeLLMSection />
      )}
    </>
  )
}
