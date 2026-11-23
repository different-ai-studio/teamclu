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

  it("maps a missing session onto the unbound key", () => {
    expect(composerDraftKey(null)).toBe(UNBOUND_COMPOSER_KEY);
    expect(composerDraftKey(undefined)).toBe(UNBOUND_COMPOSER_KEY);
    expect(composerDraftKey("session-1")).toBe("session-1");
  });
});
