import { beforeEach, describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/lib/attachments/composer-attachment";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  UNBOUND_COMPOSER_KEY,
  composerDraftKey,
  hydrateComposerDraftFiles,
  setComposerDraftCloudReader,
  useComposerDraftStore,
} from "../composer-draft-store";

const file: ComposerAttachment = {
  kind: "local",
  name: "notes.txt",
  size: 4,
  path: "/tmp/notes.txt",
};

describe("composer draft store", () => {
  beforeEach(() => {
    setComposerDraftCloudReader(null);
    useComposerDraftStore.getState().clearAll();
  });

  it("keeps text and files on the session they were written to", () => {
    const store = useComposerDraftStore.getState();
    store.setText("a", "hello");
    store.setFiles("a", [file]);
    store.setText("b", "other");

    expect(store.text("a")).toBe("hello");
    expect(useComposerDraftStore.getState().files("a")).toEqual([file]);
    expect(useComposerDraftStore.getState().text("b")).toBe("other");
    expect(useComposerDraftStore.getState().files("b")).toEqual([]);
    expect(useComposerDraftStore.getState().text("c")).toBe("");
  });

  it("drops empty text and empty file lists", () => {
    const store = useComposerDraftStore.getState();
    store.setText("a", "hello");
    store.setFiles("a", [file]);
    store.setText("a", "");
    store.setFiles("a", []);

    expect(useComposerDraftStore.getState().textByKey).toEqual({});
    expect(useComposerDraftStore.getState().filesByKey).toEqual({});
  });

  it("copies a draft onto a new session and leaves the source until send", () => {
    const store = useComposerDraftStore.getState();
    store.setText(UNBOUND_COMPOSER_KEY, "draft");
    store.setFiles(UNBOUND_COMPOSER_KEY, [file]);

    store.copyOnto(UNBOUND_COMPOSER_KEY, "session-1");

    expect(useComposerDraftStore.getState().text(UNBOUND_COMPOSER_KEY)).toBe("draft");
    expect(useComposerDraftStore.getState().text("session-1")).toBe("draft");
    expect(useComposerDraftStore.getState().files("session-1")).toEqual([file]);

    const taken = useComposerDraftStore.getState().takeForSend(
      "session-1",
      UNBOUND_COMPOSER_KEY,
    );
    expect(taken).toEqual({ text: "draft", files: [file] });
    expect(useComposerDraftStore.getState().text("session-1")).toBe("");
    expect(useComposerDraftStore.getState().text(UNBOUND_COMPOSER_KEY)).toBe("");
    expect(useComposerDraftStore.getState().filesByKey).toEqual({});

    useComposerDraftStore.getState().restore("session-1", taken.text, taken.files);
    expect(useComposerDraftStore.getState().text("session-1")).toBe("draft");
    expect(useComposerDraftStore.getState().files("session-1")).toEqual([file]);
    expect(useComposerDraftStore.getState().text(UNBOUND_COMPOSER_KEY)).toBe("");
  });

  it("keeps text and local paths after a restart, and does not store picked file bytes", () => {
    const store = useComposerDraftStore.getState();
    const picked = { kind: "cloud" as const, file: new File(["hello-bytes"], "pic.png") };
    store.setText("a", "hello");
    store.setFiles("a", [file, picked]);

    const saved = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(saved.textByKey.a).toBe("hello");
    expect(saved.filesByKey.a).toEqual([file]);
    expect(JSON.stringify(saved)).not.toContain("hello-bytes");

    useComposerDraftStore.setState({ textByKey: {}, filesByKey: {} });
    useComposerDraftStore.getState().loadPersisted();

    expect(useComposerDraftStore.getState().text("a")).toBe("hello");
    expect(useComposerDraftStore.getState().files("a")).toEqual([file]);
  });

  it("stores a cloud attachment as its path and reads that file back", async () => {
    const store = useComposerDraftStore.getState();
    const picked = {
      kind: "cloud" as const,
      file: new File(["hello-bytes"], "pic.png", { type: "image/png" }),
      path: "/tmp/pic.png",
    };
    store.setFiles("a", [picked]);

    const saved = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(saved.filesByKey.a).toEqual([
      { kind: "cloud", name: "pic.png", size: picked.file.size, path: "/tmp/pic.png", type: "image/png" },
    ]);
    expect(JSON.stringify(saved)).not.toContain("hello-bytes");

    useComposerDraftStore.setState({ textByKey: {}, filesByKey: {} });
    useComposerDraftStore.getState().loadPersisted();
    setComposerDraftCloudReader(async () => new File(["from-disk"], "pic.png", { type: "image/png" }));
    await hydrateComposerDraftFiles();

    const restored = useComposerDraftStore.getState().files("a");
    expect(restored).toHaveLength(1);
    const cloud = restored[0];
    expect(cloud?.kind).toBe("cloud");
    if (cloud?.kind !== "cloud") return;
    expect(cloud.path).toBe("/tmp/pic.png");
    expect(await cloud.file.text()).toBe("from-disk");
  });

  it("keeps a cloud path when the draft changes before the file is read back", async () => {
    const store = useComposerDraftStore.getState();
    const picked = {
      kind: "cloud" as const,
      file: new File(["hello-bytes"], "pic.png", { type: "image/png" }),
      path: "/tmp/pic.png",
    };
    store.setText("a", "hello");
    store.setFiles("a", [file, picked]);
    useComposerDraftStore.setState({ textByKey: {}, filesByKey: {} });
    useComposerDraftStore.getState().loadPersisted();

    let finish: (file: File | null) => void = () => {};
    setComposerDraftCloudReader(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hydrating = hydrateComposerDraftFiles();
    useComposerDraftStore.getState().setText("a", "hello!");
    useComposerDraftStore.getState().updateFiles("a", (prev) =>
      prev.filter((item) => item.kind !== "local"),
    );

    const duringRead = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(duringRead.textByKey.a).toBe("hello!");
    expect(duringRead.filesByKey.a).toEqual([
      {
        kind: "cloud",
        name: "pic.png",
        size: picked.file.size,
        path: "/tmp/pic.png",
        type: "image/png",
      },
    ]);

    finish(new File(["from-disk"], "pic.png", { type: "image/png" }));
    await hydrating;

    const restored = useComposerDraftStore.getState().files("a");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.kind).toBe("cloud");
    if (restored[0]?.kind !== "cloud") return;
    expect(await restored[0].file.text()).toBe("from-disk");
    const saved = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(saved.textByKey.a).toBe("hello!");
    expect(saved.filesByKey.a[0].path).toBe("/tmp/pic.png");
  });

  it("keeps a cloud path added beside a new file, and drops it once the user removes it", async () => {
    const store = useComposerDraftStore.getState();
    const picked = {
      kind: "cloud" as const,
      file: new File(["hello-bytes"], "pic.png", { type: "image/png" }),
      path: "/tmp/pic.png",
    };
    const extra: ComposerAttachment = { kind: "local", name: "b.txt", size: 1, path: "/tmp/b.txt" };
    store.setFiles("a", [picked]);
    useComposerDraftStore.setState({ textByKey: {}, filesByKey: {} });
    useComposerDraftStore.getState().loadPersisted();
    useComposerDraftStore.getState().updateFiles("a", (prev) => [...prev, extra]);

    const duringRead = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(duringRead.filesByKey.a).toEqual([
      extra,
      {
        kind: "cloud",
        name: "pic.png",
        size: picked.file.size,
        path: "/tmp/pic.png",
        type: "image/png",
      },
    ]);

    setComposerDraftCloudReader(async () => new File(["from-disk"], "pic.png", { type: "image/png" }));
    await hydrateComposerDraftFiles();
    expect(useComposerDraftStore.getState().files("a").map((item) => item.path)).toEqual([
      "/tmp/b.txt",
      "/tmp/pic.png",
    ]);

    useComposerDraftStore.getState().setFiles("a", [extra]);
    useComposerDraftStore.getState().setText("a", "left");
    const saved = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(saved.textByKey.a).toBe("left");
    expect(saved.filesByKey.a).toEqual([extra]);
  });

  it("keeps the cloud path when the disk read fails", async () => {
    const store = useComposerDraftStore.getState();
    const picked = {
      kind: "cloud" as const,
      file: new File(["hello-bytes"], "pic.png", { type: "image/png" }),
      path: "/tmp/pic.png",
    };
    store.setFiles("a", [picked]);
    useComposerDraftStore.setState({ textByKey: {}, filesByKey: {} });
    useComposerDraftStore.getState().loadPersisted();
    setComposerDraftCloudReader(async () => null);
    await hydrateComposerDraftFiles();
    useComposerDraftStore.getState().setText("a", "still");

    const saved = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
    expect(saved.textByKey.a).toBe("still");
    expect(saved.filesByKey.a).toEqual([
      {
        kind: "cloud",
        name: "pic.png",
        size: picked.file.size,
        path: "/tmp/pic.png",
        type: "image/png",
      },
    ]);
    expect(useComposerDraftStore.getState().files("a")).toEqual([]);
  });

  it("does not put a cloud file back after the draft is cleared while reading", async () => {
    const store = useComposerDraftStore.getState();
    const picked = {
      kind: "cloud" as const,
      file: new File(["hello-bytes"], "pic.png", { type: "image/png" }),
      path: "/tmp/pic.png",
    };
    store.setText("a", "hello");
    store.setFiles("a", [picked]);
    useComposerDraftStore.setState({ textByKey: {}, filesByKey: {} });
    useComposerDraftStore.getState().loadPersisted();

    let finish: (file: File | null) => void = () => {};
    setComposerDraftCloudReader(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hydrating = hydrateComposerDraftFiles();
    useComposerDraftStore.getState().clear("a");
    finish(new File(["from-disk"], "pic.png", { type: "image/png" }));
    await hydrating;

    expect(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBeNull();
    expect(useComposerDraftStore.getState().files("a")).toEqual([]);
    expect(useComposerDraftStore.getState().text("a")).toBe("");
  });

  it("maps a missing session onto the unbound key", () => {
    expect(composerDraftKey(null)).toBe(UNBOUND_COMPOSER_KEY);
    expect(composerDraftKey(undefined)).toBe(UNBOUND_COMPOSER_KEY);
    expect(composerDraftKey("session-1")).toBe("session-1");
  });
});
