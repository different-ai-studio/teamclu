import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CHAT_SCROLL_TO_MESSAGE_EVENT,
  findChatMessageElement,
  flashChatMessage,
  jumpToMessageById,
  requestChatScrollToMessage,
  scrollChatMessageIntoView,
} from "@/lib/ui/chat-scroll-to-message";

describe("chat-scroll-to-message", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("findChatMessageElement returns the matching row", () => {
    document.body.innerHTML = `
      <div data-chat-messages>
        <div data-testid="chat-message" data-message-id="m1">one</div>
        <div data-testid="chat-message" data-message-id="m2">two</div>
      </div>
    `;
    expect(findChatMessageElement("m2")?.textContent).toBe("two");
    expect(findChatMessageElement("missing")).toBeNull();
  });

  it("scrollChatMessageIntoView scrolls the message list container", () => {
    const container = document.createElement("div");
    container.setAttribute("data-chat-messages", "");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollHeight", { value: 1000 });
    container.scrollTop = 0;
    container.scrollTo = vi.fn();

    const message = document.createElement("div");
    message.getBoundingClientRect = () =>
      ({
        top: 500,
        bottom: 560,
        height: 60,
      }) as DOMRect;
    container.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 500,
      }) as DOMRect;
    container.appendChild(message);

    const scrolled = scrollChatMessageIntoView(message, { behavior: "instant" });
    expect(scrolled).toBe(true);
    expect(container.scrollTo).toHaveBeenCalled();
  });

  it("requestChatScrollToMessage dispatches a window event", () => {
    const handler = vi.fn();
    window.addEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
    requestChatScrollToMessage("target-id");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      (handler.mock.calls[0][0] as CustomEvent<{ messageId: string }>).detail.messageId,
    ).toBe("target-id");
    window.removeEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
  });

  it("jumpToMessageById scrolls immediately when the row is mounted", () => {
    document.body.innerHTML = `
      <div data-chat-messages style="height: 200px; overflow: auto;">
        <div data-testid="chat-message" data-message-id="m1" style="height: 40px;">one</div>
      </div>
    `;
    const el = findChatMessageElement("m1")!;
    const container = el.closest("[data-chat-messages]") as HTMLElement;
    container.scrollTo = vi.fn();

    expect(jumpToMessageById("m1")).toBe(true);
    expect(container.scrollTo).toHaveBeenCalled();
    expect(el.classList.contains("agent-reply-quote-flash")).toBe(true);
  });

  it("jumpToMessageById requests scroll when the row is not mounted yet", () => {
    const handler = vi.fn();
    window.addEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
    expect(jumpToMessageById("missing-id")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
  });

  it("flashChatMessage toggles the highlight class", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    flashChatMessage(el);
    expect(el.classList.contains("agent-reply-quote-flash")).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(el.classList.contains("agent-reply-quote-flash")).toBe(false);
    vi.useRealTimers();
  });
});
