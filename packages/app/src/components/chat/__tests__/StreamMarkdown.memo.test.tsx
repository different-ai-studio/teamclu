import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const parsed: string[] = [];
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parsed.push(children);
    return <div>{children}</div>;
  },
}));

import { Message } from "@/packages/ai/message";
import { StreamMarkdown } from "@/components/chat/StreamMarkdown";

function Bubble({ text }: { text: string }) {
  return (
    <Message from="assistant">
      <StreamMarkdown text={text} />
    </Message>
  );
}

describe("StreamMarkdown inside Message", () => {
  // Closed paragraphs are memoized StableBlocks, but they read MessageContext.
  // A fresh context value on every <Message> render re-rendered all of them,
  // so each streaming delta re-parsed the whole reply instead of its tail.
  it("re-parses only the growing tail when the parent re-renders with a delta", () => {
    const head = "para one\n\npara two\n\n";
    const { rerender } = render(<Bubble text={`${head}tail`} />);
    parsed.length = 0;

    for (let i = 0; i < 5; i++) {
      act(() => {
        rerender(<Bubble text={`${head}tail${"!".repeat(i + 1)}`} />);
      });
    }

    expect(parsed.filter((c) => c === "para one")).toEqual([]);
    expect(parsed.filter((c) => c === "para two")).toEqual([]);
    expect(parsed.some((c) => c.startsWith("tail!"))).toBe(true);
  });
});
