import { describe, expect, it, vi } from "vitest";
import { createAuthModule } from "@/lib/backend/cloud-api/auth";
import type { AuthClient } from "@/lib/auth";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

describe("auth.updatePassword", () => {
  it("forwards only the new password to the signed-in user update", async () => {
    const updateUser = vi.fn().mockResolvedValue({ user: { id: "u1" } });
    const auth = createAuthModule(
      {} as CloudApiClient,
      { updateUser } as unknown as AuthClient,
    );

    await auth.updatePassword("correct-horse");

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith({ password: "correct-horse" });
  });
});
