import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updatePassword, sessionBox, toastSuccess } = vi.hoisted(() => ({
  updatePassword: vi.fn(),
  sessionBox: { session: { user: { id: "u1" } } as { user: { id: string } } | null },
  toastSuccess: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (state: { session: typeof sessionBox.session }) => unknown) =>
    selector({ session: sessionBox.session }),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ auth: { updatePassword } }),
}));

import { PasswordCard } from "../PasswordCard";

function fill(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
}

describe("PasswordCard", () => {
  beforeEach(() => {
    sessionBox.session = { user: { id: "u1" } };
    updatePassword.mockReset();
    toastSuccess.mockReset();
  });

  it("stays hidden when nobody is signed in", () => {
    sessionBox.session = null;
    render(<PasswordCard />);
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("does not submit when the confirmation differs", () => {
    render(<PasswordCard />);
    fill("correct-horse", "correct-house");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updatePassword).not.toHaveBeenCalled();
    expect(screen.getByText("The two passwords do not match")).toBeInTheDocument();
  });

  it("does not submit a password shorter than 8 characters", () => {
    render(<PasswordCard />);
    fill("short1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updatePassword).not.toHaveBeenCalled();
    expect(screen.getByText("Use at least 8 characters")).toBeInTheDocument();
  });

  it("saves the new password, then clears the fields", async () => {
    updatePassword.mockResolvedValue(undefined);
    render(<PasswordCard />);
    fill("correct-horse");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updatePassword).toHaveBeenCalledWith("correct-horse"));
    expect(toastSuccess).toHaveBeenCalled();
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
  });

  it("shows the server message and keeps the typed password", async () => {
    updatePassword.mockRejectedValue(new Error("Password should be different from the old password."));
    render(<PasswordCard />);
    fill("correct-horse");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Password should be different from the old password.")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveValue("correct-horse");
  });
});
