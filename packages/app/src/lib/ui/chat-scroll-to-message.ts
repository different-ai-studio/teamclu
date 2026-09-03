/** Scroll a chat message into view without disturbing outer sticky headers. */

export const CHAT_SCROLL_TO_MESSAGE_EVENT = "teamclaw:chat-scroll-to-message";

export type ChatScrollToMessageDetail = {
  messageId: string;
};

/** Extra offset so the target clears the sticky chat header inside the list. */
const SCROLL_TOP_INSET_PX = 12;

export function findChatMessageElement(messageId: string): HTMLElement | null {
  const id = messageId.trim();
  if (!id) return null;
  return document.querySelector(
    `[data-testid="chat-message"][data-message-id="${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
}

export function scrollChatMessageIntoView(
  messageEl: HTMLElement,
  options?: {
    behavior?: ScrollBehavior;
    block?: "center" | "start" | "nearest";
  },
): boolean {
  const container = messageEl.closest("[data-chat-messages]") as HTMLElement | null;
  const behavior = options?.behavior ?? "smooth";
  const block = options?.block ?? "start";

  if (!container) {
    messageEl.scrollIntoView({ behavior, block });
    return false;
  }

  const containerRect = container.getBoundingClientRect();
  const messageRect = messageEl.getBoundingClientRect();
  const relativeTop = messageRect.top - containerRect.top + container.scrollTop;

  let targetScrollTop: number;
  switch (block) {
    case "center":
      targetScrollTop =
        relativeTop - (container.clientHeight - messageRect.height) / 2;
      break;
    case "nearest":
      if (
        messageRect.top >= containerRect.top &&
        messageRect.bottom <= containerRect.bottom
      ) {
        return true;
      }
      targetScrollTop = relativeTop - SCROLL_TOP_INSET_PX;
      break;
    case "start":
    default:
      targetScrollTop = relativeTop - SCROLL_TOP_INSET_PX;
      break;
  }

  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTo({
    top: Math.max(0, Math.min(targetScrollTop, maxScroll)),
    behavior,
  });
  return true;
}

export function flashChatMessage(messageEl: HTMLElement): void {
  messageEl.classList.remove("agent-reply-quote-flash");
  void messageEl.offsetWidth;
  messageEl.classList.add("agent-reply-quote-flash");
  window.setTimeout(() => {
    messageEl.classList.remove("agent-reply-quote-flash");
  }, 1100);
}

export function requestChatScrollToMessage(messageId: string): void {
  const id = messageId.trim();
  if (!id) return;
  window.dispatchEvent(
    new CustomEvent<ChatScrollToMessageDetail>(CHAT_SCROLL_TO_MESSAGE_EVENT, {
      detail: { messageId: id },
    }),
  );
}

export function jumpToMessageById(messageId: string): boolean {
  const id = messageId.trim();
  if (!id) return false;

  const el = findChatMessageElement(id);
  if (el) {
    scrollChatMessageIntoView(el);
    flashChatMessage(el);
    return true;
  }

  requestChatScrollToMessage(id);
  return true;
}
