/**
 * Agent Operations for Diff Review.
 *
 * Provides prompt templates for Agent actions on selected diff content:
 * - Explain Change: Ask Agent to explain what the changes do
 * - Refactor: Ask Agent to suggest refactoring improvements
 * - Generate Patch: Ask Agent to generate a patch file
 */

export type AgentOperation = 'explain' | 'refactor' | 'generatePatch' | 'review';

interface AgentPromptOptions {
  /** The selected diff text */
  diffText: string;
  /** The file path */
  filePath: string;
  /** Custom instructions (optional) */
  customInstructions?: string;
}

/**
 * Generate an Agent prompt for a given operation.
 */
export function generateAgentPrompt(
  operation: AgentOperation,
  options: AgentPromptOptions,
): string {
  const { diffText, filePath, customInstructions } = options;

  const fileContext = `File: \`${filePath}\``;
  const diffBlock = `\`\`\`diff\n${diffText}\n\`\`\``;

  switch (operation) {
    case 'explain':
      return [
        `Please explain the following code changes.`,
        fileContext,
        '',
        diffBlock,
        '',
        `Describe what these changes do, why they might have been made, and any potential impact on the codebase.`,
        customInstructions ? `\nAdditional context: ${customInstructions}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    case 'refactor':
      return [
        `Please review the following code changes and suggest refactoring improvements.`,
        fileContext,
        '',
        diffBlock,
        '',
        `Consider:`,
        `- Code readability and maintainability`,
        `- Performance optimizations`,
        `- Design pattern improvements`,
        `- Error handling`,
        `- Type safety`,
        customInstructions ? `\nAdditional context: ${customInstructions}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    case 'generatePatch':
      return [
        `Based on the following code changes, generate a clean unified patch file.`,
        fileContext,
        '',
        diffBlock,
        '',
        `Please output a properly formatted unified diff patch that can be applied with \`git apply\`.`,
        customInstructions ? `\nAdditional context: ${customInstructions}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    case 'review':
      return [
        `Please review the following code changes in \`${filePath}\`:`,
        '',
        diffBlock,
        '',
        `Provide:`,
        `1. A summary of what changed`,
        `2. Any potential issues or bugs`,
        `3. Suggestions for improvement`,
        customInstructions ? `\nAdditional context: ${customInstructions}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    default:
      return `Review the following changes in ${filePath}:\n\n${diffBlock}`;
  }
}
