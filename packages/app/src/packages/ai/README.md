# `src/packages/ai` — vendored chat primitives

STR-13. This directory looks like a package and is imported like one
(`@/packages/ai/message`), but it is not a dependency and never was in this
repo's history: it arrived whole in `0f585b2a6` ("reset to new codebase"),
carried over from the `teamclaw-next` prototype, where it started as a copy of
the [Vercel AI Elements](https://ai-sdk.dev/elements) chat components
(`Message`, `MessageContent`, `MessageResponse`, `PromptInput`) — the naming,
the context-based composition and the `from="user" | "assistant"` prop shape are
all still recognisably theirs.

**It is a fork, not a copy.** Roughly nothing of the original rendering path
survives unmodified. Do not try to update it from upstream, and do not expect an
upstream fix to apply here. What diverged:

- `MessageResponse` renders through `react-markdown` + `remark-gfm` with a
  bespoke component table (Shiki code blocks, Mermaid, task lists, workspace-
  relative image resolution fenced to the session directory — SEC-5).
- Streaming is this app's, not upstream's: `StreamingTailContext` marks the
  growing tail so per-frame work (highlighting, diagram fencing, image scans)
  is skipped until a block closes — see `components/chat/StreamMarkdown.tsx`.
- `PromptInput` grew mention parsing (`@member`, `#skill`, `/command`), file
  chips backed by a contenteditable (`editable-with-file-chips.tsx`), and
  clipboard-image capture.
- Branch navigation (`MessageBranch*`), reasoning blocks, sources and the
  actions row were deleted — this product has one reply per turn.

**Where the boundary is.** Everything here is presentation. It reads
`useMessageContext()` and props; it does not import stores, and it should stay
that way — the chat feature code in `components/chat/` is what talks to state.

Vendored rather than depended on because upstream ships these as
copy-into-your-repo source (a `shadcn`-style registry), not as a versioned
runtime package: there is no upgrade path to give up.
