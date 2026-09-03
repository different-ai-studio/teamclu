import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  attachMock,
  detachMock,
  onExitMock,
  resizeMock,
  writeMock,
  closeMock,
  xtermWriteMock,
  xtermDisposeMock,
} = vi.hoisted(() => ({
  attachMock: vi.fn(),
  detachMock: vi.fn(async () => {}),
  onExitMock: vi.fn(async () => () => {}),
  resizeMock: vi.fn(async () => {}),
  writeMock: vi.fn(async () => {}),
  closeMock: vi.fn(async () => {}),
  xtermWriteMock: vi.fn(),
  xtermDisposeMock: vi.fn(),
}));

vi.mock("@/lib/terminal/client", () => ({
  attachTerminal: attachMock,
  onTerminalExit: onExitMock,
  resizeTerminal: resizeMock,
  writeTerminal: writeMock,
  closeTerminal: closeMock,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(function () {
    return {
      open: vi.fn(),
      write: xtermWriteMock,
      dispose: xtermDisposeMock,
      loadAddon: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      focus: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
      options: {},
    }
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    }
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function () { return {} }),
}));

import { XtermInstance } from "@/components/terminal/XtermInstance";

/**
 * Drive `attachTerminal` the way the backend does: the snapshot is the first
 * chunk on the channel, live output follows, all before the promise resolves
 * or after — order across the two is not something the component may assume.
 */
function attachDelivering(chunks: Uint8Array[]) {
  attachMock.mockImplementation(async (_id: string, onData: (c: Uint8Array) => void) => {
    for (const chunk of chunks) onData(chunk);
    return {
      sink_id: 7,
      cols: 80,
      rows: 24,
      status: "running",
      exit_code: null,
      detach: detachMock,
    };
  });
}

describe("XtermInstance", () => {
  beforeEach(() => {
    attachMock.mockReset();
    attachDelivering([new Uint8Array([104, 105, 10])]); // "hi\n"
    detachMock.mockClear();
    onExitMock.mockClear();
    onExitMock.mockResolvedValue(() => {});
    xtermWriteMock.mockClear();
    xtermDisposeMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(() => cleanup());

  test("on mount: attaches and replays the snapshot chunk", async () => {
    render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    expect(attachMock).toHaveBeenCalledWith("t1", expect.any(Function));
    expect(xtermWriteMock).toHaveBeenCalledWith(new Uint8Array([104, 105, 10]));
  });

  test("an empty snapshot is not written but still triggers the repaint", async () => {
    attachDelivering([new Uint8Array(0)]);
    render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    // Only the "" repaint write, never an empty byte write.
    const byteWrites = xtermWriteMock.mock.calls.filter(([arg]) => arg instanceof Uint8Array);
    expect(byteWrites).toHaveLength(0);
    expect(xtermWriteMock).toHaveBeenCalledWith("", expect.any(Function));
  });

  test("live chunks after the snapshot are written in order", async () => {
    attachDelivering([
      new Uint8Array([37, 32]), // "% " snapshot
      new Uint8Array([108, 115]), // "ls" live
    ]);
    render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    const byteWrites = xtermWriteMock.mock.calls
      .map(([arg]) => arg)
      .filter((arg): arg is Uint8Array => arg instanceof Uint8Array);
    expect(byteWrites).toEqual([new Uint8Array([37, 32]), new Uint8Array([108, 115])]);
  });

  test("on unmount: detaches and disposes xterm but does NOT call terminal_close", async () => {
    const { unmount } = render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    unmount();
    expect(detachMock).toHaveBeenCalled();
    expect(xtermDisposeMock).toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });
});
