const AGENT_ACTOR_TYPES = ["agent", "personal_agent", "role_agent"] as const

export function isAgentActorType(actorType: string | null | undefined): boolean {
  return !!actorType && AGENT_ACTOR_TYPES.includes(actorType as (typeof AGENT_ACTOR_TYPES)[number])
}
