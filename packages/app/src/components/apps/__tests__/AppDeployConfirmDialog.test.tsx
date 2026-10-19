import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDeployConfirmDialog } from "../AppDeployConfirmDialog";
import { publicDeployConfirm, registerDeployConfirmHandler } from "@/lib/apps/app-deploy-confirm";

const domainChoice = {
  currentUrl: "https://shop.apps.example",
  codeUrl: "https://a-k7m2q9vx4n8p.apps.example",
};

afterEach(() => vi.restoreAllMocks());

describe("AppDeployConfirmDialog", () => {
  beforeEach(() => {
    render(<StrictMode><AppDeployConfirmDialog /></StrictMode>);
  });

  it("resolves true when the user continues deploy", async () => {
    const user = userEvent.setup();
    let pending!: Promise<boolean>;
    act(() => { pending = publicDeployConfirm.run("公开访问警告\n\n确定继续吗？"); });
    expect(await screen.findByText(/公开访问警告/)).toBeTruthy();
    await user.click(screen.getByText("继续部署"));
    await expect(pending).resolves.toBe(true);
  });

  it.each([false, true])("submits the domain choice only when accepted (chosen: %s)", async (checked) => {
    const user = userEvent.setup();
    const onDomainChoice = vi.fn();
    let pending!: Promise<boolean>;
    act(() => { pending = publicDeployConfirm.run("公开访问警告", { domainChoice, onDomainChoice }); });
    const checkbox = await screen.findByRole("checkbox", { name: /部署成功后，改用应用代码域名/ });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(domainChoice.currentUrl)).toBeTruthy();
    expect(screen.getByText(domainChoice.codeUrl)).toBeTruthy();
    expect(screen.getByText(/原域名仍可访问/)).toBeTruthy();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    if (checked) await user.click(checkbox);
    expect(onDomainChoice).not.toHaveBeenCalled();
    await user.click(screen.getByText("继续部署"));
    await expect(pending).resolves.toBe(true);
    expect(onDomainChoice).toHaveBeenCalledExactlyOnceWith(checked);
  });

  it.each(["cancel", "dismiss"])("%s never submits the checked domain choice", async (action) => {
    const user = userEvent.setup();
    const onDomainChoice = vi.fn();
    let pending!: Promise<boolean>;
    act(() => { pending = publicDeployConfirm.run("公开访问警告", { domainChoice, onDomainChoice }); });
    await user.click(await screen.findByRole("checkbox"));
    if (action === "cancel") await user.click(screen.getByText("取消"));
    else await user.keyboard("{Escape}");
    await expect(pending).resolves.toBe(false);
    expect(onDomainChoice).not.toHaveBeenCalled();
  });

  it("migration checkbox resets between accepted attempts", async () => {
    const user = userEvent.setup();
    const onDomainChoice = vi.fn();
    let first!: Promise<boolean>;
    act(() => { first = publicDeployConfirm.run("公开访问警告", { domainChoice, onDomainChoice }); });
    expect((await screen.findByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByText("继续部署"));
    await expect(first).resolves.toBe(true);
    expect(onDomainChoice).toHaveBeenCalledExactlyOnceWith(true);

    let second!: Promise<boolean>;
    act(() => { second = publicDeployConfirm.run("公开访问警告", { domainChoice, onDomainChoice }); });
    expect((await screen.findByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByText("继续部署"));
    await expect(second).resolves.toBe(true);
    expect(onDomainChoice.mock.calls).toEqual([[true], [false]]);
  });

  it("the ordinary deployment popup has no domain checkbox", async () => {
    const user = userEvent.setup();
    let pending!: Promise<boolean>;
    act(() => { pending = publicDeployConfirm.run("公开访问警告"); });
    await screen.findByText("公开访问警告");
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByText("取消"));
    await expect(pending).resolves.toBe(false);
  });
});

it("without a checkbox-capable handler, confirmation never opts into migration", async () => {
  registerDeployConfirmHandler(null);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onDomainChoice = vi.fn();
  await expect(publicDeployConfirm.run("公开访问警告", { domainChoice, onDomainChoice })).resolves.toBe(true);
  expect(onDomainChoice).not.toHaveBeenCalled();
});
