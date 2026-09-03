import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppDeployConfirmDialog } from "../AppDeployConfirmDialog";
import { publicDeployConfirm } from "@/lib/apps/app-deploy-confirm";

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

describe("AppDeployConfirmDialog", () => {
  beforeEach(() => {
    render(<AppDeployConfirmDialog />);
  });

  it("resolves true when the user continues deploy", async () => {
    const user = userEvent.setup();
    const pending = publicDeployConfirm.run("公开访问警告\n\n确定继续吗？");

    expect(await screen.findByText(/公开访问警告/)).toBeTruthy();
    await user.click(screen.getByText("继续部署"));

    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the user cancels", async () => {
    const user = userEvent.setup();
    const pending = publicDeployConfirm.run("公开访问警告");

    expect(await screen.findByText(/公开访问警告/)).toBeTruthy();
    await user.click(screen.getByText("取消"));

    await expect(pending).resolves.toBe(false);
  });
});
