# FC Custom Runtime passthrough — design

**Date:** 2026-09-11  
**Status:** draft (awaiting review)  
**Scope:** Align TeamClu app deploy start contract with Alibaba Cloud Function Compute (FC) 2023-03-30 Custom Runtime / Custom Container APIs. Split build from start. Hard-cut the old `runtime` + `entry` declaration.

## 1. Problem

Today an app declares:

```json
{ "runtime": "node" | "container", "entry": "server/index.mjs", "port": 9000 }
```

The control plane then invents the FC start command (`command: ["/opt/nodejs20/bin/node"]`, `args: [entry]`) and hardcodes `runtime: "custom.debian10"` plus the Nodejs20 layer. That is a private dialect:

- It cannot express what the FC console calls「启动命令」/「监听端口」directly.
- Adding Python / Go / PHP / Java means growing our translator table, not letting the app state FC’s own fields.
- `runtime` currently means both **how to build** (pnpm vs docker) and **how to start** (node vs container).

FC’s real surface for custom runtimes is small and stable:

| FC field | Role |
|---|---|
| `runtime` | `custom` / `custom.debian10` / `custom.debian11` / `custom.debian12` / `custom-container` |
| `customRuntimeConfig.command` | `string[]` |
| `customRuntimeConfig.args` | `string[]` |
| `customRuntimeConfig.port` | listen port |
| `customRuntimeConfig.healthCheckConfig` | optional |
| `layers` | ARN list |
| `customContainerConfig` | image (+ optional command/args/port) for `custom-container` |

Console modes (默认 / 命令 / Bash 脚本 / 数组) are UI sugar over `command` + `args`.

## 2. Goals / non-goals

**Goals**

1. `teamclu.app.json` start block is a near-passthrough of FC Custom Runtime config.
2. Build and start are separate declarations.
3. First-wave build kinds: `node` / `python` / `go` / `php` / `java` / `container`.
4. Hard cut: old `runtime` + `entry` shape is rejected; no dual-read period.

**Non-goals**

- FC console-parity UI picker (language → Debian → framework). Intent lives in the repo; Agent edits the file.
- Built-in FC runtimes (`nodejs20`, `python3.10`, …) — those are handler-based and refuse `customRuntimeConfig`.
- Auto-rewriting existing customer repos.
- Shipping every console “stack” (ThinkPHP, Swoole, …) as a first-class build kind.

## 3. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| D1 | Alignment depth | Passthrough of FC start fields |
| D2 | Old shape | Hard cut (reject; Agent/migration rewrites) |
| D3 | Build vs start | Orthogonal: `build` + `start` |
| D4 | Build kinds (v1) | `node` / `python` / `go` / `php` / `java` / `container` |
| D5 | Schema shape | Nested `build` + `start` (not a flat CreateFunction mirror, not presets) |

## 4. `teamclu.app.json` contract

Product fields (`title`, `auth`, …) stay. Top-level `runtime` / `entry` are removed.

```json
{
  "title": "notes",
  "auth": { "mode": "none" },
  "build": {
    "kind": "python",
    "output": ".",
    "command": null
  },
  "start": {
    "fcRuntime": "custom.debian12",
    "command": ["python3"],
    "args": ["app.py"],
    "port": 9000,
    "layers": [],
    "healthCheckPath": "/health"
  }
}
```

### 4.1 `build` (daemon only)

| Field | Rule |
|---|---|
| `kind` | Required: `node` \| `python` \| `go` \| `php` \| `java` \| `container` |
| `output` | Code-package root relative to checkout. Unused for `container`. |
| `command` | Optional override of the kind’s default build steps (single shell string). |
| `dockerfile` / `context` | `container` only; must stay inside the workdir. |

### 4.2 `start` (almost verbatim to FC)

| Field | Maps to |
|---|---|
| `fcRuntime` | CreateFunction `runtime`. For `build.kind === "container"`, platform forces `custom-container` (field may be omitted). Allowed for code apps: `custom` \| `custom.debian10` \| `custom.debian11` \| `custom.debian12`. |
| `command` / `args` | `customRuntimeConfig.command` / `.args` (array mode). Required for non-container (non-empty `command`). Optional for container (image ENTRYPOINT/CMD wins when omitted). |
| `port` | `customRuntimeConfig.port` or container port. Integer 1–65535. |
| `layers` | Function `layers`. **Omitted** → platform default layers for `build.kind` (if any). **Explicit `[]`** → no layers. Non-empty → those ARNs only (must look like FC layer ARNs). |
| `healthCheckPath` | Optional; path must start with `/` → `healthCheckConfig.httpGetUrl` (with platform defaults for delay/period/thresholds, same spirit as today’s container health check). |

### 4.3 Hard-cut validation

- Presence of legacy `runtime` / `entry` (or only the old shape) → **refuse build**, error names the file and fields and points at this contract.
- Missing file, or missing `build.kind` / required `start` fields → **refuse deploy**. No inference from `package.json` / Dockerfile for runtime family (that inference was a migration crutch and fights the hard cut).
- Malformed JSON → refuse build (same as today’s auth parsing severity for this file once start/build are required).

## 5. Daemon build table

Build produces an artifact only. Start command is never invented here.

| `kind` | Default steps | Product | Preconditions |
|---|---|---|---|
| `node` | `pnpm install --frozen-lockfile` then `pnpm build` (or `build.command`) | zip(`output`, default `.output`) | `package.json` |
| `python` | If `requirements.txt`: `pip install -r requirements.txt -t <output>`; else skip install | zip(`output`, default `.`) | `requirements.txt` / `pyproject.toml` / declared entry path exists |
| `go` | `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o <output>/main .` (or override) | zip(`output`) | `go.mod` |
| `php` | If `composer.json`: `composer install --no-dev`; else skip | zip(`output`, default `.`) | `composer.json` or declared entry |
| `java` | Maven wrapper or Gradle by lockfile (or override) | zip(`output` under conventional `target` / `build/libs`) | `pom.xml` / `build.gradle*` |
| `container` | Existing `docker build` + registry push | image reference | `dockerfile` present |

Rules:

1. Honor `build.kind`; do not branch on “has package.json ⇒ node”.
2. Non-empty `build.command` replaces the kind’s default steps (still cwd = workdir, still timed out).
3. Failure messages name `kind` and the missing file.
4. Report the resolved `{ build, start }` with the build result so finalize does not re-guess.

### 5.1 Template default `start` (editable)

| kind | `fcRuntime` | Default layers (when `layers` omitted) | Default `command` + `args` | `port` |
|---|---|---|---|---|
| node | `custom.debian10` | official Nodejs20 (pinned version, region-substituted ARN) | `["/opt/nodejs20/bin/node"]` + `["server/index.mjs"]` | 9000 |
| python | `custom.debian10` | official Python310 | `["python3"]` + `["app.py"]` | 9000 |
| go | `custom.debian10` | official Go1 | `["./main"]` + `[]` | 9000 |
| php | `custom.debian10` | official PHP81-Debian10 | template-chosen PHP serve command as arrays | 9000 |
| java | `custom.debian10` | official Java17 | `["java"]` + `["-jar", "app.jar"]` (paths match build output) | 9000 |
| container | `custom-container` | none | omit | declared or 9000 |

Layer ARNs stay pinned (immutable layer versions), same rationale as today’s Nodejs20 pin.

## 6. Control plane → FC

On finalize:

1. Accept the daemon’s resolved `{ build, start }` (+ archive object key or image).
2. Validate (§4); do not translate `entry` into a binary anymore.
3. Assemble CreateFunction / UpdateFunction:

```text
runtime               ← start.fcRuntime
                        (force custom-container when build.kind = container)
customRuntimeConfig   ← { command, args, port, healthCheckConfig? }
                        (code apps only)
layers                ← resolveLayers(start.layers, build.kind)
customContainerConfig ← image + port (+ optional command/args)
code                  ← OSS location for archive apps; absent for container
```

4. Validation failure → HTTP 400, no partial function update.
5. Re-send full runtime shape on every update (same reason as today: old functions must heal on redeploy).

`parseAppRuntimeSpec` / `RUNTIME_BINARIES` / `isSupportedRuntime("node"|"container")` are replaced by parsers for `build` + `start`. `assertDeployAllowed` checks `build.kind` against the six allowed kinds.

## 7. Data model

| Column | New meaning |
|---|---|
| `amux.apps.runtime` | Stores **`build.kind`** (`node` \| `python` \| `go` \| `php` \| `java` \| `container`). List/filter only. |
| `amux.apps.start_spec` (new, jsonb, nullable) | Snapshot of `start` from last successful deploy. Control plane read-only; source of truth remains the repo file. |

Migration:

- Widen `apps_runtime_check` to the six kinds.
- Existing rows keep `node` / `container` (still valid kinds); `start_spec` starts null until next successful deploy.
- No backfill of `start_spec` from guesses.

OpenAPI: expand `AppRuntime` enum; finalize body carries `build` + `start` instead of `{ runtime, entry, port }`.

Clients (desktop, daemon local API, control panel copy) stop documenting `entry`; show `build.kind` + read-only `start_spec` / checkout file.

## 8. Migration / rollout

| Target | Action |
|---|---|
| Built-in templates | Rewrite once to `build` + `start`; delete legacy fields; update `AGENTS.md`. |
| Existing Gitea apps | Do **not** rewrite. Next deploy fails closed with a pointed error until Agent (or human) updates `teamclu.app.json`. |
| DB | Constraint widen + `start_spec` column; no forced redeploy. |
| Tests | Replace old `parseAppRuntimeSpec` cases; add regression: legacy shape → 400. |

Rollout order: schema + FC client + daemon parser/build table + templates + OpenAPI/clients. Prefer one PR train that cannot deploy an old-shaped template after merge.

## 9. Error handling

| Case | Behavior |
|---|---|
| Legacy `runtime`/`entry` present | Build refused; message cites fields and new contract |
| Missing `teamclu.app.json` | Deploy refused (no silent node default) |
| `start.layers` omitted vs `[]` | Omitted = kind defaults; `[]` = no layers |
| Unsupported `fcRuntime` | Finalize 400 |
| `build.kind=container` without image on finalize | 400 (unchanged intent) |
| Build precondition missing (e.g. no `go.mod`) | Build error names kind + file |

## 10. Testing

1. New node template deploy: function is `custom.debian10`, Node layer attached, `command`/`args`/`port` match file.
2. Python kind with `command: ["python3"]`, `args: ["app.py"]` boots.
3. Legacy `{ runtime, entry }` checkout fails with readable error.
4. Container path unchanged: no layers, no code zip, image-based config.
5. List API `runtime` still filterable; value equals `build.kind`.
6. Explicit `layers: []` on node does not attach Nodejs20 (escape hatch for debian-builtin interpreters).
7. UpdateFunction on redeploy refreshes command/layers/port (regression against “code-only update leaves broken start”).

## 11. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Preset names (`python3.12-web`) expanded at deploy | Reintroduces a dialect; fights “align with FC” |
| Flat CreateFunction-shaped root | Mixes build + start; half the fields nonsense for container |
| Dual-read old+new forever | Per product choice: hard cut |
| Infer kind from package.json when file missing | Undermines hard cut; imported repos must declare |
| Built-in FC runtimes | Incompatible with `customRuntimeConfig` |

## 12. Acceptance checklist

- [ ] Templates ship valid `build` + `start` only.
- [ ] Daemon build table implements six kinds with override `build.command`.
- [ ] FC ensure/update uses passthrough `start` (no `RUNTIME_BINARIES` translator).
- [ ] `amux.apps.runtime` = `build.kind`; `start_spec` written on successful finalize.
- [ ] Legacy declaration fails closed.
- [ ] OpenAPI + client types updated; control panel does not edit start/build (repo is source of truth).

## 13. Relation to prior specs

- [2026-08-27 apps-config-in-code](./2026-08-27-apps-config-in-code-design.md) sketched a placeholder `build: { command, outdir }` that deploy did not fully consume. This spec **replaces** that placeholder with `build.kind` + optional `build.command` + `build.output`, and adds required `start`.
- [2026-08-27 apps-self-serve-gitea-fc](./2026-08-27-apps-self-serve-gitea-fc-design.md) introduced `amux.apps.runtime` as `node|container`. Column kept; enum and meaning become `build.kind`.
- Control-panel rule from [2026-09-10](./2026-09-10-app-control-panel-design.md) still holds: runtime/start are not editable in the panel; they are pushed from the repo on deploy.

## 14. Follow-ups (out of this spec)

- Richer template pack per language (Flask / Express / Spring) — still just files, not new platform kinds.
- debian12 as default once regional availability covers our deploy region.
- Optional control-plane “diff expected start vs live FC getFunction” diagnostics.
