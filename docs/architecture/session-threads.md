# Session threads (agent-reply fork)

Discord-style threads: only **agent_reply** messages can spawn a thread. A thread is a **new cloud session** (`source=thread`) with `parent_session_id` + `thread_root_message_id`, hidden from the main session list.

## Pi backend (MVP)

Lazy fork on first `runtimeStart` in the thread session:

1. Client sends `RuntimeStartRequest.fork_from { parent_session_id, root_message_id }`.
2. Daemon reads parent `runtimes.toml` binding + anchor message `metadata.backend_session.fork_point.pi_leaf_id`.
3. Pi host `fork_session` → `SessionManager.createBranchedSession(leafId)` → new `pi:/path.jsonl`.
4. Thread runtime attaches with `resume_acp_session_id` and `forbid_new_session_fallback`.

## Opencode backend

Same lazy fork flow; anchor metadata uses `fork_point.opencode_message_id` (assistant `msg_…`).

Opencode `POST /session/{id}/fork` treats `messageID` as an **exclusive** upper bound (`id >= messageID` stops copying). At fork time the daemon loads `GET /session/{parent}/message`, finds the anchor, and passes the **next** message id as cutoff (or omits `messageID` when the anchor is the last message) so the branched session includes the anchor agent reply — matching Pi's inclusive `createBranchedSession(leafId)`.

## API

- `POST /v1/sessions/{parentId}/threads` `{ rootMessageId }` (idempotent)
- `GET /v1/sessions/{parentId}/thread-summaries`

## UI

Right **380px ThreadPanel** inside Chat column; dual composer (main + thread). See `docs/design/thread-panel-mockup.html`.
