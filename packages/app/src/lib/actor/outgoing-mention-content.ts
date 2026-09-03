import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

/** Inline human mention chip (same shape as Skill/Role enhanced chips). */
export function buildHumanMentionChip(
  displayName: string,
  instruction?: string,
): string {
  const name = displayName.trim();
  const hint =
    instruction?.trim() ||
    `This message also mentions human ${name}`;
  return `[Mentioned: ${name}|instruction: ${hint}]`;
}

/**
 * Skill / role invocation chip. The hidden instruction must name a tool the
 * target backend actually has: `skill()` / `role_load()` are opencode plugin
 * tools, while Claude Code loads skills through its native Skill tool —
 * telling Claude to call a nonexistent `skill()` makes it answer
 * conversationally first and only reach for the skill later.
 */
export function buildEnhancedChip(
  type: "role" | "skill",
  name: string,
  backendType?: string,
): string {
  const label = type === "role" ? "Role" : "Skill";
  if (type === "skill" && backendType === "claude-code") {
    return `[Skill: ${name}|instruction:You must run the "${name}" skill (via your Skill tool) before any other action.]`;
  }
  const toolCall =
    type === "role"
      ? `role_load({ name: "${name}" })`
      : `skill({ name: "${name}" })`;
  return `[${label}: ${name}|instruction:You must call ${toolCall} before any other action.]`;
}

/** Agent mention stays as a structured prefix line. */
export function buildStructuredMentionLines(
  agent: Pick<AttachedAgent, "displayName"> | null,
): string[] {
  const agentName = agent?.displayName?.trim();
  if (!agentName) return [];
  return [`[Mentioned agents: ${agentName}]`];
}

export function hasStructuredMentionLines(content: string): boolean {
  return /\[Mentioned agents:[^\]]*\]/i.test(content);
}
