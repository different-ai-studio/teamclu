import { describe, expect, it } from "vitest";
import {
  QUESTION_SETTLED_MARKER,
  answererLabel,
  answersRecordFromOrdered,
  parseQuestionSettlementResult,
} from "../question-settlement";

describe("parseQuestionSettlementResult", () => {
  it("reads the trailer the question tool appends", () => {
    const text = [
      "方向: A",
      `${QUESTION_SETTLED_MARKER}${JSON.stringify({
        answeredBy: "member-1",
        answers: [["A"]],
        rejected: false,
      })}`,
    ].join("\n");
    expect(parseQuestionSettlementResult(text)).toEqual({
      answeredBy: "member-1",
      answers: [["A"]],
      rejected: false,
    });
  });

  it("ignores a result that was written before settlements were marked", () => {
    expect(parseQuestionSettlementResult("方向: A")).toBeNull();
  });
});

describe("answersRecordFromOrdered", () => {
  it("keys each answer by question id and by index", () => {
    expect(
      answersRecordFromOrdered([{ id: "q-1" }, { id: "" }], [["A"], ["B", "C"]]),
    ).toEqual({
      "q-1": "A",
      "0": "A",
      "1": "B, C",
    });
  });
});

describe("answererLabel", () => {
  it("uses the directory name when the id is known", () => {
    expect(answererLabel("member-1", [{ id: "member-1", name: "张三" }])).toBe("张三");
  });

  it("keeps a short unmatched string, which is already a display name", () => {
    expect(answererLabel("张三", [])).toBe("张三");
  });

  it("shortens an unmatched id", () => {
    expect(answererLabel("123e4567-e89b-12d3-a456-426614174000", [])).toBe("123e4567");
  });
});
