import { describe, it, expect, beforeEach, vi } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclu_pb";
import { useSessionMessageStore } from "./session-message-store";
import { useSessionSelectionStore } from "./session-selection-store";
import { useSessionStore } from "./session-store";

const { mockAnswerAcpQuestion } = vi.hoisted(() => ({
  mockAnswerAcpQuestion: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/teamclu/answer-question", () => ({
  answerAcpQuestion: mockAnswerAcpQuestion,
}));

beforeEach(() => {
  mockAnswerAcpQuestion.mockReset();
  mockAnswerAcpQuestion.mockResolvedValue(undefined);
  useSessionMessageStore.setState({ messages: {}, messageRefreshTrigger: 0 });
  useSessionSelectionStore.setState({ activeSessionId: null, currentSessionId: null });
  useSessionStore.setState({
    messages: {},
    currentSessionId: null,
    pendingQuestions: [],
    answeredQuestionsByToolCallId: {},
  });
});

describe("session-store", () => {
  const fakeMessage = (id: string, content = "x") =>
    createMessage(MessageSchema, {
      messageId: id, sessionId: "s1", senderActorId: "a1",
      kind: MessageKind.TEXT, content, createdAt: BigInt(1),
    });

  it("appends messages", () => {
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    expect(useSessionStore.getState().messages["s1"].length).toBe(1);
  });

  it("dedupes by messageId", () => {
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    expect(useSessionMessageStore.getState().messages["s1"].length).toBe(1);
  });

  it("returns currentMessages for currentSessionId", () => {
    useSessionSelectionStore.setState({ currentSessionId: "s1", activeSessionId: "s1" });
    useSessionMessageStore.setState({ messages: { s1: [fakeMessage("m1")] } });
    expect(useSessionStore.getState().currentMessages().length).toBe(1);
  });

  it("does not snapshot answered question state before answer RPC succeeds", async () => {
    mockAnswerAcpQuestion.mockRejectedValueOnce(new Error("rpc failed"));
    useSessionStore.setState({
      pendingQuestions: [
        {
          questionId: "q1",
          toolCallId: "tc1",
          messageId: "m1",
          sessionId: "s1",
          agentActorId: "a1",
          questions: [
            {
              id: "q-1",
              header: "Pick",
              question: "Which?",
              options: [{ label: "A", value: "a" }],
            },
          ],
        },
      ],
    });

    await expect(
      useSessionStore.getState().answerQuestion({ "q-1": "A" }, "q1"),
    ).rejects.toThrow("rpc failed");

    expect(useSessionStore.getState().answeredQuestionsByToolCallId).toEqual({});
    expect(useSessionStore.getState().pendingQuestions).toHaveLength(1);
  });

  it("snapshots answered question state after answer RPC succeeds", async () => {
    useSessionStore.setState({
      pendingQuestions: [
        {
          questionId: "q1",
          toolCallId: "tc1",
          messageId: "m1",
          sessionId: "s1",
          agentActorId: "a1",
          questions: [
            {
              id: "q-1",
              header: "Pick",
              question: "Which?",
              options: [{ label: "A", value: "a" }],
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().answerQuestion({ "q-1": "A" }, "q1");

    expect(mockAnswerAcpQuestion).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().answeredQuestionsByToolCallId.tc1).toEqual({
      questions: [
        {
          id: "q-1",
          header: "Pick",
          question: "Which?",
          options: [{ label: "A", value: "a" }],
        },
      ],
      answers: { "q-1": "A" },
    });
    expect(useSessionStore.getState().pendingQuestions).toHaveLength(0);
  });
});
