import { describe, it, expect } from 'vitest';
import { generateAgentPrompt } from '../agent-operations';
import type { AgentOperation } from '../agent-operations';

describe('generateAgentPrompt', () => {
  const defaultOptions = {
    diffText: '+const a = 1;\n-const b = 2;',
    filePath: 'src/utils.ts',
  };

  it('should generate explain prompt', () => {
    const prompt = generateAgentPrompt('explain', defaultOptions);
    expect(prompt).toContain('explain');
    expect(prompt).toContain('src/utils.ts');
    expect(prompt).toContain('+const a = 1;');
    expect(prompt).toContain('```diff');
  });

  it('should generate refactor prompt', () => {
    const prompt = generateAgentPrompt('refactor', defaultOptions);
    expect(prompt).toContain('refactoring');
    expect(prompt).toContain('Code readability');
    expect(prompt).toContain('Performance');
    expect(prompt).toContain('```diff');
  });

  it('should generate patch prompt', () => {
    const prompt = generateAgentPrompt('generatePatch', defaultOptions);
    expect(prompt).toContain('patch');
    expect(prompt).toContain('git apply');
    expect(prompt).toContain('```diff');
  });

  it('should generate review prompt', () => {
    const prompt = generateAgentPrompt('review', defaultOptions);
    expect(prompt).toContain('review');
    expect(prompt).toContain('summary');
    expect(prompt).toContain('```diff');
  });

  it('should include custom instructions when provided', () => {
    const prompt = generateAgentPrompt('explain', {
      ...defaultOptions,
      customInstructions: 'Focus on security implications',
    });
    expect(prompt).toContain('Focus on security implications');
  });

  it('should not include custom instructions line when not provided', () => {
    const prompt = generateAgentPrompt('explain', defaultOptions);
    expect(prompt).not.toContain('Additional context');
  });

  it('should include file path in all operations', () => {
    const operations: AgentOperation[] = ['explain', 'refactor', 'generatePatch', 'review'];
    for (const op of operations) {
      const prompt = generateAgentPrompt(op, defaultOptions);
      expect(prompt).toContain('src/utils.ts');
    }
  });

  it('should include diff block in all operations', () => {
    const operations: AgentOperation[] = ['explain', 'refactor', 'generatePatch', 'review'];
    for (const op of operations) {
      const prompt = generateAgentPrompt(op, defaultOptions);
      expect(prompt).toContain('```diff');
      expect(prompt).toContain('```');
    }
  });
});
