import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeCloudApi, switchExtensionServer, server } = vi.hoisted(() => ({
  probeCloudApi: vi.fn(),
  switchExtensionServer: vi.fn(async () => "switched" as const),
  server: {
    override: null as string | null,
    defaultUrl: "https://official.example.com" as string | undefined,
    effective: "https://official.example.com" as string | undefined,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@/lib/config/bootstrap", () => ({ probeCloudApi }));

vi.mock("@/lib/extension/switch-server", () => ({ switchExtensionServer }));

vi.mock("@/lib/config/server-config", () => ({
  displayHost: (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  getCloudApiUrlOverride: () => server.override,
  getDefaultCloudApiUrl: () => server.defaultUrl,
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: server.effective }),
  normalizeCloudApiUrl: (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, "");
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return trimmed;
    } catch {
      return null;
    }
  },
}));

import { ExtensionServerSwitch } from "../ExtensionServerSwitch";

beforeEach(() => {
  probeCloudApi.mockReset();
  switchExtensionServer.mockReset();
  switchExtensionServer.mockResolvedValue("switched");
  server.override = null;
  server.defaultUrl = "https://official.example.com";
  server.effective = "https://official.example.com";
});

describe("ExtensionServerSwitch", () => {
  it("opens a server form from the login footer", () => {
    render(<ExtensionServerSwitch signedIn={false} variant="footer" />);

    expect(screen.getByText("official.example.com")).toBeInTheDocument();
    expect(screen.queryByTestId("extension-server-form")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /switch server/i }));

    expect(screen.getByTestId("extension-server-form")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /official server/i })).toBeDisabled();
  });

  it("saves a custom server after the probe succeeds", async () => {
    probeCloudApi.mockResolvedValue({ ok: true });
    render(<ExtensionServerSwitch signedIn={false} variant="footer" />);

    fireEvent.click(screen.getByRole("button", { name: /switch server/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /cloud api url/i }), {
      target: { value: "https://custom.example.com/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(probeCloudApi).toHaveBeenCalledWith("https://custom.example.com"));
    expect(switchExtensionServer).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://custom.example.com", signedIn: false }),
    );
  });

  it("keeps the previous server when the probe fails, and still allows an override", async () => {
    probeCloudApi.mockResolvedValue({ ok: false, reason: "unreachable" });
    render(<ExtensionServerSwitch signedIn={false} variant="panel" />);

    fireEvent.change(screen.getByRole("textbox", { name: /cloud api url/i }), {
      target: { value: "https://custom.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/could not reach that address/i)).toBeInTheDocument();
    expect(switchExtensionServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /save it anyway/i }));

    await waitFor(() =>
      expect(switchExtensionServer).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://custom.example.com", signedIn: false }),
      ),
    );
  });

  it("returns to the official server", async () => {
    server.override = "https://custom.example.com";
    server.effective = "https://custom.example.com";
    render(<ExtensionServerSwitch signedIn variant="panel" />);

    expect(screen.getByText(/switching signs you out/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /official server/i }));

    await waitFor(() =>
      expect(switchExtensionServer).toHaveBeenCalledWith(
        expect.objectContaining({ url: null, signedIn: true }),
      ),
    );
  });
});
