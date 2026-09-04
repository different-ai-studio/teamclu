import { PiLLMSection } from './PiLLMSection'
import { AgentModelDefaults } from './llm/AgentModelDefaults'

/**
 * The LLM settings pane.
 *
 * pi is the only local agent runtime (#1247), so there is one pane: pi's
 * providers live in its own `auth.json` / `models.json` and are reached through
 * the pi SDK, which the daemon drives on our behalf (`/v1/pi/*`).
 *
 * The defaults block sits above the runtime pane: "which model does each
 * surface run on" is a property of the device, not of the runtime.
 */
export function LLMSection() {
  return (
    <>
      <AgentModelDefaults />
      <PiLLMSection />
    </>
  )
}
