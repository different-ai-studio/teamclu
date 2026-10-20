import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useExternalLinkHandler } from "@/hooks/use-external-link-handler";

const { openExternalUrl, openAdminConsoleTab } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  openAdminConsoleTab: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}));

vi.mock("@/lib/extension/admin-sso-inject", () => ({
  openAdminConsoleTab: () => openAdminConsoleTab(),
}));

function Probe({ href, admin = false }: { href: string; admin?: boolean }) {
  useExternalLinkHandler();
  return (
    <a href={href} {...(admin ? { "data-admin-console-entry": "" } : {})}>
      open
    </a>
  );
}

describe("useExternalLinkHandler", () => {
  it("opens http(s) links in the system browser", () => {
    openExternalUrl.mockClear();
    render(<Probe href="https://example.com/docs" />);

    fireEvent.click(screen.getByRole("link"));

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("leaves non-http links alone", () => {
    openExternalUrl.mockClear();
    render(<Probe href="mailto:someone@example.com" />);

    fireEvent.click(screen.getByRole("link"));

    expect(openExternalUrl).not.toHaveBeenCalled();
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
