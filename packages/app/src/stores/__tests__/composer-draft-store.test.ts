import { beforeEach, describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/lib/attachments/composer-attachment";
import {
  UNBOUND_COMPOSER_KEY,
  composerDraftKey,
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

  it("maps a missing session onto the unbound key", () => {
    expect(composerDraftKey(null)).toBe(UNBOUND_COMPOSER_KEY);
    expect(composerDraftKey(undefined)).toBe(UNBOUND_COMPOSER_KEY);
    expect(composerDraftKey("session-1")).toBe("session-1");
  });
});
