# kb-maintainer (P0)

Independent compiler for `documents/` → `knowledge/wiki/`.

- **Slice 1** `dry-run`: print an ingest plan. No download, no LLM, no vault writes.
- **Slice 2** `ingest`: extract sources, compile with the fake runner, validate, commit or roll back.
- **Slice 3** `publish`: copy the maintainer `wiki/` tree into the team vault `knowledge/wiki/` with crash replay. Does not set `allow_bulk_add` / `allow_bulk_delete`.
- **Slice 4** extractors: Markdown / Office / PDF text gate / vision fallback (replace, never concat). Audio/video is `unsupported`.
- **Slice 5** `estimate` / `lint` / `eval`: vision budget preview, batch gate, 20-question structural eval.

See `docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md` and `RUNBOOK.md`.

## Dry-run

```bash
node scripts/kb-maintainer/cli.js dry-run \
  --config ~/kb-maintainer/<team-id>/config.json \
  --state ~/kb-maintainer/<team-id>/state/state.json \
  --documents-root ~/.amuxd/teams/<team-id>/shared/team-sync/documents \
  --knowledge-root ~/.amuxd/teams/<team-id>/shared/team-sync/knowledge \
  --node-id <device-node-id> \
  --known-json /tmp/known.json \
  --acl-json /tmp/acl-prefixes.json
```

`--acl-json` must be a JSON array of Path ACL prefixes from `GET /v1/teams/{teamId}/knowledge-acl`. Omitting it fails closed. An empty array means the team has no ACL rules.

## Estimate (required before vision)

```bash
node scripts/kb-maintainer/cli.js estimate \
  --config ~/kb-maintainer/<team-id>/config.json \
  --state ~/kb-maintainer/<team-id>/state/state.json \
  --documents-root ~/.amuxd/teams/<team-id>/shared/team-sync/documents \
  --knowledge-root ~/.amuxd/teams/<team-id>/shared/team-sync/knowledge \
  --node-id <device-node-id> \
  --known-json /tmp/known.json \
  --acl-json /tmp/acl-prefixes.json
```

`visionPages × models.visionPagePrice`. Image-only or low-quality PDF pages are counted; text PDFs that pass the gate are not. Ingest still will not call vision unless a `visionExtract` hook is injected **and** `--accept-vision-estimate` is set. The CLI does not ship a live vision caller.

## Ingest

```bash
node scripts/kb-maintainer/cli.js ingest \
  --config ~/kb-maintainer/<team-id>/config.json \
  --state ~/kb-maintainer/<team-id>/state/state.json \
  --documents-root ~/.amuxd/teams/<team-id>/shared/team-sync/documents \
  --knowledge-root ~/.amuxd/teams/<team-id>/shared/team-sync/knowledge \
  --work-root ~/kb-maintainer/<team-id> \
  --node-id <device-node-id> \
  --known-json /tmp/known.json \
  --acl-json /tmp/acl-prefixes.json \
  --runner fake
```

`--runner pi` is a stub until the Pi host is wired. Low-quality PDFs fail closed (`extraction_failed`) unless a vision hook is provided.

## Lint / eval / publish

```bash
node scripts/kb-maintainer/cli.js lint --config ... --state ... --work-root ...
node scripts/kb-maintainer/cli.js eval --work-root ... [--eval-json scripts/kb-maintainer/fixtures/eval-20.json]
node scripts/kb-maintainer/cli.js publish --config ... --state ... --knowledge-root ... --work-root ... \
  [--daemon-url http://127.0.0.1:<amuxd-port> --daemon-token <loopback-token>]
```

`publish` via the CLI runs the batch lint first. Deterministic errors block the vault write; warnings do not. Without a sync adapter the publisher records `published_local_sync_pending`.

The real whitelist stays on the dedicated machine. Do not commit a team's live `config.json`.

## Tests

```bash
node --test scripts/kb-maintainer/*.test.js
```
