import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QuestionCard } from '../QuestionCard';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const mockSessionState = {
  pendingQuestions: [] as Array<{
    questionId: string;
    toolCallId: string;
    messageId: string;
    questions: unknown[];
  }>,
  answeredQuestionsByToolCallId: {} as Record<
    string,
    { questions: unknown[]; answers: Record<string, string> }
  >,
  answerQuestion: vi.fn(() => Promise.resolve()),
};

vi.mock('@/stores/session-store', () => ({
  useSessionStore: (selector: (s: typeof mockSessionState) => unknown) =>
    selector(mockSessionState),
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    question: 'What would you like to do?',
    header: 'Choose an option',
    options: [
      { label: 'Option A', value: 'option-a' },
      { label: 'Option B', value: 'option-b' },
    ],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('QuestionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.pendingQuestions = [];
    mockSessionState.answeredQuestionsByToolCallId = {};
    mockSessionState.answerQuestion = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    cleanup();
  });

  it('renders question text and options', async () => {
    const question = makeQuestion();
    mockSessionState.pendingQuestions = [
      {
        questionId: 'event-1',
        toolCallId: 'tc-1',
        messageId: 'msg-1',
        questions: [question],
      },
    ];

    render(
      <QuestionCard
        toolCallId="tc-1"
        questions={[question as never]}
        isCompleted={false}
      />
    );

    const card = screen.getByTestId('question-card');
    expect(card).toHaveAttribute('data-state', 'open');
    expect(within(card).getByText('What would you like to do?')).toBeTruthy();
    expect(within(card).getByText('Option A')).toBeTruthy();
    expect(within(card).getByText('Option B')).toBeTruthy();
  });

  it('clicking an option and submitting calls answerQuestion with correct mapping', async () => {
    const question = makeQuestion();
    const answerMock = vi.fn(() => Promise.resolve());
    mockSessionState.pendingQuestions = [
      {
        questionId: 'event-1',
        toolCallId: 'tc-1',
        messageId: 'msg-1',
        questions: [question],
      },
    ];
    mockSessionState.answerQuestion = answerMock;

    render(
      <QuestionCard
        toolCallId="tc-1"
        questions={[question as never]}
        isCompleted={false}
      />
    );

    // Click Option A
    const card = screen.getByTestId('question-card');
    const optionAButton = within(card).getByText('Option A').closest('button');
    expect(optionAButton).not.toBeNull();
    fireEvent.click(optionAButton!);

    // Click the Submit Answer button
    const submitButton = within(card).getByText('Submit Answer');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(answerMock).toHaveBeenCalledWith({ 'q-1': 'option-a' }, 'event-1');
    });
  });

  it('renders answered snapshot after completion when pending question is gone', () => {
    const question = makeQuestion();
    mockSessionState.answeredQuestionsByToolCallId = {
      'tc-1': {
        questions: [question],
        answers: { 'q-1': 'Option A' },
      },
    };

    render(
      <QuestionCard toolCallId="tc-1" isCompleted />,
    );

    expect(screen.getByText('What would you like to do?')).toBeTruthy();
    expect(screen.getByText('Option A')).toBeTruthy();
  });
});
