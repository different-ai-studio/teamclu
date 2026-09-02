import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFile } from '@tauri-apps/plugin-fs';
import { useSessionStore } from '@/stores/session';
import { useSessionListStore } from '@/stores/session-list-store';
import {
  useV2StreamingStore,
  type AgentStreamEntry,
} from '@/stores/v2-streaming-store';
import { MessageList } from '../MessageList';
import type { Message } from '@/stores/session';

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

const readFileMock = vi.mocked(readFile);

// ── Helpers ────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random()}`,
    sessionId: 'sess-1',
    role: 'user',
    content: 'test content',
    parts: [],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(),
    ...overrides,
  };
}

function makeAssistantWithTokens(
  overrides: Partial<Message> & { input: number; output: number },
): Message {
  const { input, output, ...messageOverrides } = overrides;
  return makeMessage({
    role: 'assistant',
    tokens: {
      input,
      output,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...messageOverrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('MessageList', () => {
  beforeEach(() => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    useSessionListStore.setState({ loading: false });
    useSessionStore.setState({
      isLoading: false,
      messageQueue: [],
      activeSessionId: 'sess-1',
      sessions: [],
    });
    useV2StreamingStore.setState({
      byKey: {},
      archived: [],
    });
  });

  it('messages render in order', () => {
    const msg1 = makeMessage({
      id: 'msg-1',
      role: 'user',
      content: 'First message',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });
    const msg2 = makeMessage({
      id: 'msg-2',
      role: 'assistant',
      content: 'Second message',
      timestamp: new Date('2024-01-01T10:01:00Z'),
    });

    const { container } = render(
      <MessageList
        messages={[msg2, msg1]} // Passed out of order intentionally
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />
    );

    const text = container.textContent || '';
    const firstIdx = text.indexOf('First message');
    const secondIdx = text.indexOf('Second message');
    // First message should appear before second message in the rendered output
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('empty state renders when passed as emptyState prop with no messages', () => {
    const emptyStateNode = <div data-testid="custom-empty">No messages yet</div>;

    const { getByTestId } = render(
      <MessageList
        messages={[]}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
        emptyState={emptyStateNode}
      />
    );

    expect(getByTestId('custom-empty')).toBeTruthy();
  });

  it('keeps welcome emptyState visible while session list isLoading with no active session', () => {
    useSessionListStore.setState({ loading: true });
    useSessionStore.setState({ activeSessionId: null });
    const emptyStateNode = <div data-testid="welcome-empty">Ready when you are</div>;

    const { getByTestId, queryByTestId } = render(
      <MessageList
        messages={[]}
        activeSessionId={null}
        isStreaming={false}
        streamingMessageId={null}
        emptyState={emptyStateNode}
      />,
    );

    expect(getByTestId('welcome-empty')).toBeTruthy();
    expect(queryByTestId('message-list-session-loading')).toBeNull();
  });

  it('shows session loading spinner when isLoading with an active session and no messages', () => {
    useSessionListStore.setState({ loading: true });
    useSessionStore.setState({ activeSessionId: 'sess-1' });

    const { getByTestId, queryByTestId } = render(
      <MessageList
        messages={[]}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
        emptyState={<div data-testid="welcome-empty">Ready</div>}
      />,
    );

    expect(getByTestId('message-list-session-loading')).toBeTruthy();
    expect(queryByTestId('welcome-empty')).toBeNull();
  });

  it('windows to the latest 80 messages and expands on demand', () => {
    const messages = Array.from({ length: 140 }, (_, index) =>
      makeMessage({
        id: `msg-${index.toString().padStart(3, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index}`,
        timestamp: new Date(2024, 0, 1, 0, index),
      }),
    );

    render(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    // 140 > VIRTUAL_MSG_THRESHOLD, so rows come from the virtualizer and are not
    // individually assertable in jsdom (the scroll container measures 0px). The
    // window size is still observable through the load-earlier affordance.
    expect(screen.getByText('Load 60 earlier messages')).toBeTruthy();

    fireEvent.click(screen.getByText('Load 60 earlier messages'));

    expect(screen.queryByText(/earlier messages/)).toBeNull();
  });

  it('hides completed assistant token usage while the next assistant step is streaming', () => {
    const completedAssistant = makeAssistantWithTokens({
      id: 'assistant-complete',
      content: 'Done',
      timestamp: new Date('2024-01-01T10:00:00Z'),
      input: 2500,
      output: 33,
    });
    const pendingAssistant = makeMessage({
      id: 'pending-assistant',
      role: 'assistant',
      content: '',
      timestamp: new Date('2024-01-01T10:01:00Z'),
      isStreaming: true,
    });

    const { container } = render(
      <MessageList
        messages={[completedAssistant, pendingAssistant]}
        activeSessionId="sess-1"
        isStreaming={true}
        streamingMessageId="pending-assistant"
      />,
    );

    expect(container.textContent).not.toContain('↓2.5k');
    expect(container.textContent).not.toContain('↑33');
    expect(container.textContent).not.toContain('tokens');
  });

  it('shows one aggregate token total after assistant steps complete', () => {
    const firstStep = makeAssistantWithTokens({
      id: 'assistant-step-1',
      content: 'First step',
      timestamp: new Date('2024-01-01T10:00:00Z'),
      input: 2500,
      output: 33,
    });
    const finalStep = makeAssistantWithTokens({
      id: 'assistant-step-2',
      content: 'Final step',
      timestamp: new Date('2024-01-01T10:01:00Z'),
      input: 500,
      output: 7,
    });

    const { container } = render(
      <MessageList
        messages={[firstStep, finalStep]}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    expect(container.textContent).toContain('2 steps');
    expect(container.textContent).toContain('↓3.0k');
    expect(container.textContent).toContain('↑40');
    expect((container.textContent?.match(/tokens/g) || []).length).toBe(1);
  });

  it('uses an explicit sessionDirectory for relative local image paths', async () => {
    const message = makeMessage({
      id: 'image-message',
      role: 'user',
      content: '[Image: screenshot.png]',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    render(
      <MessageList
        messages={[message]}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
        sessionDirectory="/archived/workspace"
      />,
    );

    expect(await screen.findByAltText('screenshot.png')).toBeTruthy();
    expect(readFileMock).toHaveBeenCalledWith('/archived/workspace/screenshot.png');
  });

  it('keeps following bottom streaming content after the stream has been marked inactive', async () => {
    const scrollToMock = vi.fn();
    const rafMock = vi
      .fn()
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const cancelRafMock = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;

    HTMLElement.prototype.scrollTo = scrollToMock;
    vi.stubGlobal('requestAnimationFrame', rafMock);
    vi.stubGlobal('cancelAnimationFrame', cancelRafMock);

    const userMessage = makeMessage({
      id: 'user-message',
      role: 'user',
      content: 'run pwd',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });
    const messages = [userMessage];
    const inactiveEntry: AgentStreamEntry = {
      sessionId: 'sess-1',
      actorId: 'agent-1',
      outputText: '',
      thinkingText: '',
      parts: [
        {
          id: 'part-1',
          type: 'text',
          text: 'initial stream text',
          content: 'initial stream text',
        },
      ],
      toolCalls: [],
      planEntries: [],
      pendingPermissionsByRequestId: {},
      errorMessage: null,
      errorDetails: null,
      lastUpdate: 1,
      active: false,
    };

    useV2StreamingStore.setState({
      byKey: { 'sess-1::agent-1': inactiveEntry },
      archived: [],
    });

    function Harness() {
      const byKey = useV2StreamingStore((state) => state.byKey);
      const archived = useV2StreamingStore((state) => state.archived);
      const streams = React.useMemo(
        () => {
          const current = Object.values(byKey).filter(
            (entry) => entry.sessionId === 'sess-1',
          );
          const priorTurns = archived.filter(
            (entry) => entry.sessionId === 'sess-1',
          );
          return [...priorTurns, ...current].sort(
            (a, b) => a.lastUpdate - b.lastUpdate,
          );
        },
        [archived, byKey],
      );
      const bottomContent = streams.length ? (
        <div data-testid="stream-bottom">
          {streams
            .flatMap((stream) => stream.parts)
            .map((part) => part.text || part.content || '')
            .join('')}
        </div>
      ) : null;

      return (
        <MessageList
          messages={messages}
          activeSessionId="sess-1"
          isStreaming={false}
          streamingMessageId={null}
          bottomContent={bottomContent}
        />
      );
    }

    try {
      render(<Harness />);
      expect(screen.getByTestId('stream-bottom').textContent).toContain(
        'initial stream text',
      );
      scrollToMock.mockClear();

      act(() => {
        useV2StreamingStore.getState().replaceParts('sess-1', 'agent-1', [
          {
            id: 'part-1',
            type: 'text',
            text: 'updated stream text',
            content: 'updated stream text',
          },
        ]);
      });

      expect(screen.getByTestId('stream-bottom').textContent).toContain(
        'updated stream text',
      );
      await waitFor(() => expect(scrollToMock).toHaveBeenCalled());
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
      vi.unstubAllGlobals();
    }
  });
});
