import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useSessionStore } from '@/stores/session';
import { ChatMessage } from '../ChatMessage';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/lib/i18n', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/hooks/useActorDisplayName', () => ({
  useActorDisplayName: (actorId?: string) => {
    if (actorId === 'actor-mac2') return 'MAC2';
    return actorId ?? '';
  },
  useAgentModelByActor: () => '',
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    role: 'assistant' as const,
    content: '',
    parts: [] as { id: string; type: string; text?: string; content?: string }[],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ChatMessage', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('user message renders its content', () => {
    const message = makeMessage({
      id: 'msg-user-1',
      role: 'user',
      content: 'Hello from the user',
    });

    const { container } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Hello from the user');
  });

  it('renders agent mentions from metadata before user content', () => {
    const message = makeMessage({
      id: 'msg-user-mention',
      role: 'user',
      content: '执行pwd',
      mentionActorIds: ['actor-mac2'],
    });

    const { container } = render(<ChatMessage message={message} />);

    expect(container.textContent).toContain('@MAC2');
    expect(container.textContent).toContain('执行pwd');
  });

  it('assistant message renders its content', () => {
    const message = makeMessage({
      id: 'msg-asst-1',
      role: 'assistant',
      content: 'Hello from the assistant',
      isStreaming: false,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });

    const { container } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('Hello from the assistant');
  });

  it('only shows copy action on the last assistant text output in a group', () => {
    const firstMessage = makeMessage({
      id: 'msg-asst-group-1',
      role: 'assistant',
      content: 'First assistant text',
      isStreaming: false,
    });

    const lastMessage = makeMessage({
      id: 'msg-asst-group-2',
      role: 'assistant',
      content: 'Last assistant text',
      isStreaming: false,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });

    // `activeSessionId` is the session this list belongs to, and it gates the
    // assistant actions row — ThreadBadge forks from it, so it cannot fall back
    // to whatever the store calls active. Both production call sites in
    // MessageList pass it; rendering without it is not a real configuration.
    const { rerender } = render(
      <ChatMessage
        message={firstMessage}
        activeSessionId="sess-1"
        tokenGroupInfo={{ hideTokenUsage: true }}
      />,
    );

    // The assistant copy action moved into ThreadBadge's `copySlot`, where it
    // renders as a MessageActionIconButton: a Radix tooltip plus `aria-label`
    // instead of a native `title`. The accessible name is what the reader
    // actually gets, so assert on that.
    expect(screen.queryByLabelText('Copy')).toBeNull();

    rerender(
      <ChatMessage
        message={lastMessage}
        activeSessionId="sess-1"
        tokenGroupInfo={{ hideTokenUsage: false }}
      />,
    );

    expect(screen.getByLabelText('Copy')).toBeTruthy();
  });

  it('code blocks within messages render correctly', () => {
    const message = makeMessage({
      id: 'msg-code-1',
      role: 'assistant',
      content: '```javascript\nconsole.log("hello");\n```',
      isStreaming: false,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });

    const { container } = render(<ChatMessage message={message} />);
    // Code blocks should render as code or pre elements
    const codeEl = container.querySelector('code, pre');
    expect(codeEl).not.toBeNull();
  });

  it('thinking indicator renders BEFORE message content during streaming', () => {
    // Message with thinking parts but no content yet (early streaming state)
    const message = makeMessage({
      id: 'msg-thinking-1',
      role: 'assistant',
      content: '',
      parts: [{ id: 'step-1', type: 'step-start', text: 'Starting...' }],
      isStreaming: true,
    });

    useSessionStore.setState({ activeSessionId: 'sess-1' });

    const { container } = render(<ChatMessage message={message} shouldShowThinking={true} />);
    
    // Thinking block should be present
    expect(container.textContent).toMatch(/Thinking|thinking|analyzing/i);
    
    // Get all direct children of the message container
    const messageContainer = container.querySelector('[data-testid="chat-message"]');
    expect(messageContainer).not.toBeNull();
    
    const firstChild = messageContainer?.firstElementChild;
    // First child should contain thinking-related content (Brain icon or "Thinking" text)
    expect(firstChild?.textContent).toMatch(/Thinking|analyzing/i);
  });

  it('renders completed compaction messages as a divider row without copy actions', () => {
    const message = makeMessage({
      id: 'msg-compaction',
      role: 'user',
      content: '',
      displayKind: 'compaction',
      compaction: { auto: true, overflow: true, completed: true },
    });

    const { container } = render(<ChatMessage message={message} />);

    expect(container.textContent).toContain('Context automatically compacted');
    expect(container.textContent).not.toContain('Copy');
    expect(container.querySelector('[data-message-kind="compaction"]')).toBeTruthy();
  });

  it('renders in-progress compaction messages with a pending title', () => {
    const message = makeMessage({
      id: 'msg-compaction-pending',
      role: 'user',
      content: '',
      displayKind: 'compaction',
      compaction: { auto: true, overflow: true, completed: false },
    });

    const { container } = render(<ChatMessage message={message} />);

    expect(container.textContent).toContain('Compacting context automatically...');
  });

  it('renders interrupted agent reply from turnStatus (scheme B)', () => {
    const message = makeMessage({
      id: 'msg-interrupted-1',
      role: 'assistant',
      content: '',
      parts: [
        {
          id: 'tool-part-1',
          type: 'tool-call',
          toolCallId: 't1',
          toolCall: {
            id: 't1',
            name: 'bash',
            status: 'completed',
            arguments: {},
            startTime: new Date(),
          },
        },
      ],
      toolCalls: [
        {
          id: 't1',
          name: 'bash',
          status: 'completed',
          arguments: {},
          startTime: new Date(),
        },
      ],
      isStreaming: false,
      senderActorId: 'actor-1',
      turnStatus: 'interrupted',
    });

    const { container } = render(<ChatMessage message={message} />);
    const text = container.textContent || '';
    const strip = container.querySelector('[data-testid="interrupted-agent-reply"]');
    const process = container.querySelector('[data-testid="agent-process-collapsible"]');

    expect(strip).toBeTruthy();
    expect(process).toBeTruthy();
    expect(text).toContain('Stopped');
    expect(text).toContain('interrupted');
    expect(text).toContain(
      'You interrupted this reply. Generated content is kept.',
    );
    expect(text).not.toContain('Turn interrupted by user');
    // Process (tools) must appear before the interrupted strip in DOM order.
    expect(
      Boolean(
        process &&
          strip &&
          Boolean(
            process.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
      ),
    ).toBe(true);
  });

  it('renders no_final_reply agent status strip', () => {
    const message = makeMessage({
      id: 'msg-nfr-1',
      role: 'assistant',
      content: '',
      parts: [
        {
          id: 'tool-part-1',
          type: 'tool-call',
          toolCallId: 't1',
          toolCall: {
            id: 't1',
            name: 'bash',
            status: 'completed',
            arguments: {},
            startTime: new Date(),
          },
        },
      ],
      toolCalls: [
        {
          id: 't1',
          name: 'bash',
          status: 'completed',
          arguments: {},
          startTime: new Date(),
        },
      ],
      isStreaming: false,
      senderActorId: 'actor-1',
      turnStatus: 'no_final_reply',
    });

    const { container } = render(<ChatMessage message={message} />);
    const text = container.textContent || '';
    const strip = container.querySelector('[data-testid="no-final-reply"]');

    expect(strip).toBeTruthy();
    expect(text).toContain('Turn finished');
    expect(text).toContain('no final reply');
    expect(text).toContain(
      'No additional written reply was produced.',
    );
    expect(text).not.toContain('Turn completed with no final reply');
  });

  it('renders unsupported native skill agent status strip', () => {
    const message = makeMessage({
      id: 'msg-native-skill-1',
      role: 'assistant',
      content: '',
      isStreaming: false,
      senderActorId: 'actor-1',
      turnStatus: 'skill_created_in_unsupported_directory',
      nativeSkillViolations: [{ slug: 'demo', root: '.opencode/skills' }],
    });

    const { container } = render(<ChatMessage message={message} />);
    const strip = container.querySelector('[data-testid="unsupported-native-skill-reply"]');

    expect(strip).toBeTruthy();
    expect(container.textContent).toContain('Skill not created');
    expect(container.textContent).toContain('demo');
    expect(container.textContent).toContain('.opencode/skills');
  });

  it('does not render hidden synthetic messages', () => {
    const message = makeMessage({
      id: 'msg-hidden',
      role: 'user',
      content: 'hidden text',
      displayKind: 'synthetic',
      hidden: true,
    });

    const { container } = render(<ChatMessage message={message} />);

    expect(container.textContent).toBe('');
  });
});
