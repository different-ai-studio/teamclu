import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { VoiceModelInstallDialog } from "../VoiceModelInstallDialog";

describe("VoiceModelInstallDialog", () => {
  it("shows both model sizes and selects F16 before installation", () => {
    const select = vi.fn();
    const install = vi.fn();
    render(
      <VoiceModelInstallDialog
        open
        installing={false}
        progress={0}
        selectedModel="q8"
        installed={false}
        installedModel={null}
        onOpenChange={vi.fn()}
        onSelectedModelChange={select}
        onInstall={install}
      />,
    );

    expect(screen.getByText("284 MB")).toBeInTheDocument();
    expect(screen.getByText("500 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByText("F16 高精度"));
    expect(select).toHaveBeenCalledWith("f16");
    fireEvent.click(screen.getByText("下载并安装"));
    expect(install).toHaveBeenCalledOnce();
  });

  it("marks the active model as installed", () => {
    render(
      <VoiceModelInstallDialog
        open
        installing={false}
        progress={1}
        selectedModel="q8"
        installed
        installedModel="q8"
        onOpenChange={vi.fn()}
        onSelectedModelChange={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "已安装" })).toBeDisabled();
  });

  it("allows an existing ASR model to install the missing CAM++ companion", () => {
    render(
      <VoiceModelInstallDialog
        open
        installing={false}
        progress={0}
        selectedModel="f16"
        installed={false}
        installedModel="f16"
        onOpenChange={vi.fn()}
        onSelectedModelChange={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "下载并安装" })).toBeEnabled();
  });
});
