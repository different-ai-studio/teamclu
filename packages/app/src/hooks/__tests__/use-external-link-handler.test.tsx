import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useExternalLinkHandler } from "@/hooks/use-external-link-handler";

const { openExternalUrl, openAdminConsoleTab, openChatHref } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  openAdminConsoleTab: vi.fn(),
  openChatHref: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}));

vi.mock("@/lib/messages/open-chat-file", () => ({
  openChatHref: (...args: unknown[]) => openChatHref(...args),
}));

vi.mock("@/lib/extension/admin-sso-inject", () => ({
  openAdminConsoleTab: () => openAdminConsoleTab(),
}));

function Probe({
  href,
  admin = false,
  chat = false,
}: {
  href: string;
  admin?: boolean;
  chat?: boolean;
}) {
  useExternalLinkHandler();
  const link = (
    <a href={href} {...(admin ? { "data-admin-console-entry": "" } : {})}>
      open
    </a>
  );
  return chat ? <div data-chat-messages>{link}</div> : link;
}

describe("useExternalLinkHandler", () => {
  it("opens http(s) links in the system browser", () => {
    openExternalUrl.mockClear();
    render(<Probe href="https://example.com/docs" />);

    fireEvent.click(screen.getByRole("link"));

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("opens mailto links in the system handler", () => {
    openExternalUrl.mockClear();
    render(<Probe href="mailto:someone@example.com" />);

    fireEvent.click(screen.getByRole("link"));

    expect(openExternalUrl).toHaveBeenCalledWith("mailto:someone@example.com");
  });

  it("sends local file links to the chat opener", () => {
    openChatHref.mockClear();
    openExternalUrl.mockClear();
    render(<Probe href="./docs/周报.md" chat />);

    fireEvent.click(screen.getByRole("link"));

    expect(openChatHref).toHaveBeenCalledWith("./docs/周报.md");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("leaves path-shaped links outside chat alone", () => {
    openChatHref.mockClear();
    render(<Probe href="/settings" />);

    fireEvent.click(screen.getByRole("link"));

    expect(openChatHref).not.toHaveBeenCalled();
  });

  it("keeps the admin console entry on its own path", async () => {
    openExternalUrl.mockClear();
    openAdminConsoleTab.mockClear();
    render(<Probe href="https://admin.example.test" admin />);

    fireEvent.click(screen.getByRole("link"));
    await vi.waitFor(() => {
      expect(openAdminConsoleTab).toHaveBeenCalled();
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
