# App deploy: intent contract — design

**Date:** 2026-09-23
**Status:** draft (awaiting review)
**Supersedes decision D1 of:** `docs/specs/2026-09-11-fc-runtime-passthrough-design.md`
**Scope:** `teamclu.app.json` gains a short form declaring *intent*; the control
plane resolves it to Function Compute start fields from a verified profile
table. The FC passthrough form stays valid and gains a preflight.

## 1. Problem

Deploying one static photo gallery took twelve fix commits. This is the git log
of `james-test2`, unedited:

```
e75b439 Initial app seed
fc26476 Create family photo gallery with time-based sorting
ac36853 Fix deployment config: add layers field
a3919d2 fix: use custom-container runtime with Node.js Dockerfile
c4742c9 fix: use custom runtime instead of custom-container
aef703d fix: add layers field back
874c3ef fix: add Node.js 20 layer for FC custom runtime
230fad2 fix: use cn-shanghai region for Node.js layer
8e6a8f2 fix: use ap-southeast-1 region for Node.js layer
6415137 fix: use Dockerfile build with Node.js 20 image
21874c9 fix: use container build kind for Dockerfile
f779830 fix: use custom-container runtime for container build
c12388c fix: use cn-beijing region for Node.js layer
a3ea9aa fix: try cn-shenzhen region
```

Four of those commits guess at a cloud region. Four more thrash between a layer
strategy and a container strategy. The reported failures were:

1. `/opt/nodejs20/bin/node is not exist`
2. `SyntaxError: Unexpected token {` — the runtime's Node could not parse ESM
3. `cross-region access is not allowed`
4. `Docker is not installed or not on PATH`

### 1.1 Why the author could not have got it right

**The deploy region is knowledge the repository does not have.** `appsRegion()`
(`services/fc/src/lib/provisioning/apps-oss.ts:47`) reads `APPS_REGION` from the
server's environment. It is not in the agent's app-workspace prompt. `fcRegion`
is stored per app and returned by `GET /v1/apps/{id}`, but only after a deploy
has succeeded — so on a first deploy the value does not exist anywhere the
author can see. Layer ARNs embed a region. Four wrong guesses was not
carelessness; guessing was the only available method.

**Nothing checked the guess before spending a deploy.** `resolveLayers`
(`app-runtime-spec.ts`) regex-checks an ARN's *shape* and passes its region
through untouched. `parseStart` even calls `resolveLayers("", ...)` — with an
empty region — purely to shape-validate, then discards the result. The mismatch
was found by Alibaba, one full build-and-deploy later.

**The platform's own defaults were never at fault.** Omitting `layers` yields a
correct, region-matched ARN. Three live apps run `Nodejs20` versions 1, 2 and 3
respectively; all three versions exist in `cn-shenzhen` and all three boot. Every
failure above came from a hand-written `start` block. The contract invited the
author to write values only the server could know, and then did not check them.

## 2. Evidence: what the runtime images actually contain

A probe deployed to `james-test2` on `custom.debian10`, then read back from the
app's own logs. Debian 10.13, **x86_64**.

```
/var/fc/lang/nodejs20/bin/node        v20.10.0      (+ npm, npx, yarn, corepack)
/var/fc/lang/nodejs18/bin/node        v18.19.0
/var/fc/lang/python3.10/bin/python3   Python 3.10.9 (+ pip, pip3, wheel)

PATH:  node → MISSING            python3 → /usr/bin/python3
       java → MISSING            php     → MISSING
       go   → MISSING            ruby    → MISSING

/opt:  nodejs20                   (nothing but the attached layer)
```

Four consequences:

- **The Nodejs20 layer is redundant on `custom.debian10`.** The image already
  ships Node 20. A config with `"layers": []` and
  `command: ["/var/fc/lang/nodejs20/bin/node"]` was deployed and served 200.
- **The Python310 layer is redundant too**, and `fcRuntime: "custom"` (Debian 9,
  Python 3.7.4) was never necessary.
- **`node` is absent from PATH on debian10** — a bare `node` command fails
  outright, not merely with an old version.
- **`python3` on PATH is `/usr/bin/python3`, not the 3.10.9.** A Python app
  written the obvious way is silently downgraded to Debian 10's system
  interpreter with no error at any stage. This trap is the reason the profile
  table emits absolute interpreter paths rather than names.

`x86_64` is also recorded here because it is the target the build machine must
match; see §8.

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| D1′ | What the author writes | **Intent** (`kind` + `entry` + `port`). Supersedes the 2026-09-11 D1 "passthrough of FC start fields". |
| D2 | Passthrough form | Kept, indefinitely. No second hard cut. |
| D3 | Who resolves | Control plane, at deploy. Not the daemon (a client must not choose the runtime — same reason finalize refuses a client-supplied `authMode`). |
| D4 | What is stored | The **expanded** spec in `start_spec`, so the panel and the agent see what actually ran. |
| D5 | Unverified profiles | Not shipped as platform choices without evidence; each row in §5 carries its provenance. |

## 4. The contract

```jsonc
{
  "title": "james-test2",
  "auth":  { "mode": "none" },
  "build": { "kind": "node", "output": ".output" },
  "start": { "entry": "server/index.mjs", "port": 9000 }
}
```

| field | rule |
|---|---|
| `start.entry` | Path **inside the code package** (the zipped `build.output` directory), not the repo. Must stay inside it — same `is_inside_workdir` check the build paths get. Optional for `go`, whose build emits `main`. |
| `start.port` | Optional, default `9000`. |
| `start.healthCheckPath` | Unchanged. |

A missing `entry` for a kind whose profile needs one (everything but `go` and
`container`) is a validation error naming the kind — never an inferred default
such as `server/index.mjs`, which would put the platform back in the business of
guessing.

Presence of any of `fcRuntime` / `command` / `args` / `layers` selects the
passthrough form. **Both shapes at once is an error**, not a precedence rule.

## 5. Profile table

Resolved by `build.kind`. The author never writes a runtime, an interpreter
path, a layer, or a region.

| kind | fcRuntime | interpreter | layers | provenance |
|---|---|---|---|---|
| node | `custom.debian10` | `/var/fc/lang/nodejs20/bin/node` | none | **Deployed and served 200** (§2) |
| python | `custom.debian10` | `/var/fc/lang/python3.10/bin/python3` | none | Binary present, reported 3.10.9. **Not yet run as an app.** |
| go | `custom.debian10` | `./main` | none | `go` absent from the image; the build already emits a static `linux/amd64` binary, so no runtime is required. **Untested.** |
| php | `custom.debian10` | from layer | `PHP81-Debian10:1` | `php` absent from the image, so a layer is required. Mount path **unverified**. |
| java | `custom.debian10` | from layer | `Java17:3` | `java` absent from the image, so a layer is required. Mount path **unverified**. |
| container | `custom-container` | — | none | Unchanged. |

Layers survive for `php` and `java` only, and the platform supplies their
region. Node and Python no longer reference a layer at all, which removes
region-scoped ARNs from the two languages in actual use.

## 6. Resolution and data flow

`parseAppDeployDeclaration` gains a resolution step: short form → profile lookup
→ a fully populated `AppStartSpec`. Everything downstream is untouched, because
`fc-client.ts` and `runtimeInput` already consume a resolved spec.

Resolution is region-free: a profile that needs a layer emits the shorthand
(`Java17:3`), which `resolveLayers` expands against the deploy region at the
existing call site. The parser therefore stays pure and testable without a
region, which is also what makes the §11 table tests possible.

The region still enters in exactly one place — `resolveLayers(cfg.region, …)` at
`fc-client.ts:267` — and for node and python the question no longer arises.

`start_spec` stores the expansion. That value already flows into the agent's
app-workspace prompt, so the agent writes four lines and reads back precisely
what the platform chose, with no new endpoint and no cache to go stale.

## 7. Passthrough preflight

Applies to the passthrough form only; all rejections occur before any call to
Alibaba.

| | rule | verdict | basis |
|---|---|---|---|
| R1 | official ARN's region ≠ deploy region | refuse, naming the deploy region and the `Name:version` shorthand | FC refuses it a round-trip later without naming a usable region |
| R2 | command reaches into `/opt/<x>` with no attached layer mounting it | refuse | `/opt` contained nothing but the attached layer (§2) |
| R3 | bare interpreter the image does not put on PATH (`node` on debian10) | refuse | `PROBE-PATH node MISSING` |
| R4 | bare `python3` on `custom.debian10` | **warn** | resolves to `/usr/bin/python3`, not 3.10.9 — a silent downgrade, but possibly deliberate |

R1–R3 are `ApiError(400, "validation_failed", …)`, the same shape every other
declaration error uses. R4 warns to the control plane's own log via
`console.warn("[apps] …")`, matching the precedent in `app-deploy.ts:507`. A
warning with no reader is nearly useless, so if §9's diagnosability gap is fixed
by surfacing deploy warnings to the caller, R4 should move to that channel.

A layer whose mount path this design has not verified makes R2 step aside rather
than guess. Blocking a working deploy on our own ignorance is worse than the
round-trip it would save.

Region-free shorthand (`Nodejs20:3`, `Java17:3`) is accepted in the passthrough
form and expanded against the deploy region, so even passthrough users need not
write a region.

## 8. Non-goals

- **The `pip` cross-platform bug.** `app_build.rs` runs
  `pip install -r requirements.txt -t <output>` on the developer's machine —
  macOS, arm64, whichever `pip` is first on PATH — while the function runs
  `linux/x86_64` (§2). Any dependency with a native wheel installs for the wrong
  platform and fails at import. The `go` branch cross-compiles correctly
  (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`); the python branch does not. This is
  real and independently diagnosed in two of this team's own sessions, but it is
  a build-correctness change in a different file with its own trade-off
  (`--only-binary=:all:` breaks source-only packages). Separate spec.
- **Issue 4, local Docker.** `container` builds require Docker on the developer's
  machine. Different subsystem (where images get built), separate spec.
- **Built-in FC runtimes.** Whether `runtime: "nodejs20"` accepts
  `customRuntimeConfig` was never established; documentation is written entirely
  around custom runtimes, and `FC_CODE_RUNTIMES` rejects the value before it
  reaches Alibaba, so it could not be tested through the product. It is also now
  largely moot: `custom.debian10` supplies current Node and Python without
  layers. Adopting a built-in runtime later is a row in §5, not a contract
  change.
- **No Python template.** All three templates are Node, which is part of why
  Python apps are hand-authored into trouble. Worth doing; not this spec.

## 9. Open questions

1. **Python has not run as an app** under the §5 profile. First real Python
   deploy should confirm it.
2. **php and java mount paths are unverified.** Their profiles are inferred from
   the interpreters' absence, not from a successful deploy.
3. **Go's static-binary assumption is untested.**
4. **A deploy can fail with no recoverable reason.** During this work a deploy
   reached `fcStatus: deploy_error` with no reason on the app record (every key
   enumerated), no entries from the logs endpoint, and nothing in the daemon
   log. `deployError` exists in the OpenAPI contract but `GET /v1/apps/{id}`
   does not return it. The identical configuration then deployed successfully,
   so the failure was transient — but its invisibility makes every other problem
   here harder to diagnose, and it deserves its own fix.
5. **The deploy confirmation modal is easy to miss.** "Confirm deploy —
   此应用未启用登录保护…" blocks the deploy until answered and appears to have
   silently swallowed two deploy attempts during this work.

## 10. Migration

Nothing is rewritten; nothing breaks. Existing passthrough repos — all five apps
in this deployment — keep deploying byte-identically. The profile table applies
only when `entry` is present. **Live apps are never silently re-profiled**:
moving a working app off its layer without being asked is the class of surprise
this design exists to end.

| Target | Action |
|---|---|
| Templates ×3 | Rewrite `teamclu.app.json` to the short form |
| Template `AGENTS.md` ×3 | Drop the FC vocabulary; document intent |
| OpenAPI | `AppStartSpec` gains `entry`; `port` becomes optional |
| Agent prompt | Platform-contract lines describe intent, not ARNs |
| `app_build.rs` | `AppStartSpec` gains `entry: Option<String>`; `port` gains a serde default of 9000; `entry` joins the `is_inside_workdir` check |

The remaining Rust surface is small because `fc_runtime`, `command`, `args` and
`layers` are already `Option` with serde defaults.

## 11. Testing

- **One test per profile row**, asserting the exact strings in §5. These
  constants *are* the design and should fail loudly when edited.
- **Regression against production reality**: the four live apps' current
  `start_spec` values, verbatim, must still parse and expand to themselves.
- **One test per rule in §7**, each asserting the message names the fix.
- **Mixed-form rejection.**
- **Round-trip**: short form → expansion → byte-identical to the
  `CreateFunction` input `runtimeInput` builds today for the equivalent
  passthrough config.

Tests cannot reach Function Compute. Rows marked unverified in §5 stay unverified
until someone deploys them; the tests pin the constants, not their truth.
