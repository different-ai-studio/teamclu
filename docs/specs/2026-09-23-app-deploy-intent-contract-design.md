# App deploy: published facts, declared intent — design

**Date:** 2026-09-23 (rewritten 2026-09-24)
**Status:** draft (awaiting review)
**Supersedes decision D1 of:** `docs/specs/2026-09-11-fc-runtime-passthrough-design.md`
**Supersedes its own D1′** (see §3): an earlier draft of this document had the
platform choose the whole start configuration from a profile table. That table
could not express the one real Python app in this deployment, and it had no
answer at all for a build host being Windows. The platform now *publishes what
it knows* and validates the result; the agent decides.

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

A second app, `james-test1`, spent twelve more commits on `requirements.txt`
alone and ended by **deleting its database driver and its entire auth module**
to get a green deploy. It is live today with no authentication because a build
tool installed the wrong binaries.

### 1.1 Every one of these is an information failure

Four commits guess a cloud region. `appsRegion()`
(`services/fc/src/lib/provisioning/apps-oss.ts:47`) reads it from the *server's*
environment; it is not in the agent's prompt, and the app's own `fcRegion` is
null until a deploy has already succeeded. Guessing was the only method
available.

Four more commits attempt a Docker build. Nothing told the agent that the
machine had no Docker until the build failed.

The Node 10 `SyntaxError` came from `fcRuntime: "custom"` being Debian 9.
Nothing said so.

The deleted auth module came from `pip` running on macOS and installing
macOS-compiled wheels for a Linux function. Nothing said what the target was.

**The agent was never short of freedom. It was short of facts.** That is the
whole diagnosis, and it decides the shape of the fix: publish what only the
platform can know, then validate the result.

## 2. Evidence

### 2.1 What the runtime image contains

A probe deployed to `james-test2` on `custom.debian10`, read back from the app's
own logs. Debian 10.13, **x86_64**.

```
/var/fc/lang/nodejs20/bin/node        v20.10.0      (+ npm, npx, yarn, corepack)
/var/fc/lang/nodejs18/bin/node        v18.19.0
/var/fc/lang/python3.10/bin/python3   Python 3.10.9 (+ pip, pip3, wheel)

PATH:  node → MISSING            python3 → /usr/bin/python3
       java → MISSING            php     → MISSING
       go   → MISSING            ruby    → MISSING

/opt:  nodejs20                   (nothing but the attached layer)
```

- **The Nodejs20 layer is redundant on `custom.debian10`.** A config with
  `"layers": []` and `command: ["/var/fc/lang/nodejs20/bin/node"]` was deployed
  and served 200. The Python310 layer is redundant for the same reason.
- **`node` is absent from PATH** — a bare `node` cannot run at all.
- **`python3` on PATH is `/usr/bin/python3`, not the 3.10.9.** A Python app
  written the obvious way is silently downgraded, with no error anywhere. This
  is why published interpreter paths are absolute.

### 2.2 One app, several build hosts, one of them Windows

The same app `a60747fc` is checked out on three machines in this team:

```
/Users/dengwei/.amuxd/…/apps/a60747fc-…      macOS
/Users/matt.chow/.amuxd/…/apps/a60747fc-…    macOS
C:/Users/lyty_/.amuxd/…/apps/a60747fc-…      Windows
```

Build-host OS is a property of **whoever runs the build**, not of the app. It
can differ between two deploys of the same commit. No host fact may be stored on
the app row or in the server-side app snapshot.

And `build.command` is committed to the repository, so one string runs on all
three. It is executed as `sh -c <command>` (`app_build.rs:298`) with **no
Windows branch anywhere in the build path**, while `james-test1`'s build command
is `rm -rf lib && pip3 install …`. See §10.

### 2.3 The build/runtime platform gap, measured

Installing a normal modern stack (`fastapi`, `sqlalchemy`, `psycopg2-binary`,
`bcrypt`, `cryptography`, `pydantic`) the way the platform does today, on a
macOS arm64 host:

```
lib/_cffi_backend.cpython-39-darwin.so
lib/pydantic_core/_pydantic_core.cpython-39-darwin.so
```

macOS binaries, CPython 3.9 ABI, destined for a linux/x86_64 CPython 3.10
function. That is exactly `psycopg2._psycopg not found`.

The same install, given the target explicitly:

```
pip install --platform manylinux2014_x86_64 --implementation cp \
            --python-version 3.10 --only-binary=:all: -r requirements.txt -t lib/

lib/psycopg2/_psycopg.cpython-310-x86_64-linux-gnu.so
lib/cryptography/hazmat/bindings/_rust.abi3.so
lib/pydantic_core/_pydantic_core.cpython-310-x86_64-linux-gnu.so
→ zero darwin binaries
```

Every package `james-test1` deleted installs correctly. No Docker, no CI.
The flags are **host-independent and target-specific**, so the same committed
command is correct on macOS and on Windows.

Known failure mode: a package with no wheel (`uwsgi`) fails under
`--only-binary=:all:` with `Could not find a version that satisfies the
requirement … (from versions: none)`, which reads as "no such package". Any
tooling that emits these flags must translate that error.

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| D1″ | Division of labour | **Platform publishes facts; agent decides; preflight validates.** Supersedes D1 (agent guesses blind) and D1′ (platform decides from a profile table). |
| D2 | Passthrough form | Kept indefinitely. No second hard cut. |
| D3 | Short form | Kept for apps whose start really is `<interpreter> <entry>`. A convenience over the facts, never the only road. |
| D4 | Fact scope | Runtime facts are app-scoped and served by the control plane. **Host facts are session-scoped** and come from the daemon running this agent. They are never mixed. |
| D5 | Honesty | Every published fact carries provenance. "Mount path unverified" is published as such; a confident wrong fact is worse than an admitted gap. |
| D6 | Preflight | Retained under both forms. Facts without validation is what we already had. |

## 4. The three kinds of fact

Blurring these is what made the earlier draft wrong, so they are kept apart by
construction: they have different scopes, different owners, and different
lifetimes.

### 4.1 Runtime facts — app-scoped, control plane

Host-independent and true wherever the build ran.

- deploy region (the value guessed four times)
- target: `linux/x86_64`, Debian version per image
- per `fcRuntime`: interpreters with **absolute paths** and versions
- per `fcRuntime`: what each bare interpreter name on PATH actually resolves to,
  including "absent"
- official layers: name, versions, mount path or an explicit "unverified"
- the code package unpack path (`/code`)

Source: `app-runtime-profiles.ts`, in the same process that assembles the app
snapshot — so there is one table, not a copy to drift.

### 4.2 Host facts — session-scoped, daemon

True only of the machine running this agent, re-derived every session.

- OS and architecture (macOS arm64, Windows x86_64, …)
- whether `docker` is present
- the shell `build.command` will be run under

Never persisted to the app row, never in the server-side snapshot: the same app
is built on macOS and Windows by different teammates (§2.2).

### 4.3 Portability constraints — derived

The consequence of §4.2 being per-host, and the part an agent cannot infer:

> `build.command` is committed to the repository and will also run on your
> teammates' machines, which include Windows, under `sh -c`.

This flips the advice a host fact alone would produce. Knowing "you are on
macOS" invites macOS-flavoured commands. The useful guidance is that
target-specific flags (`--platform manylinux2014_x86_64 --implementation cp
--python-version 3.10`) are correct on every host, while `rm -rf`, `brew`, and
backslash paths are not.

## 5. Publication surfaces

| Surface | Carries | Why |
|---|---|---|
| App workspace prompt | A short summary: region, target triple, this host's OS/arch and docker availability, and the gotcha list | Always present, no tool call to forget. The failures came from not knowing what one did not know. |
| `manage_app runtime_info` | The full table: every image, every interpreter, every layer, with provenance | Detail on demand without bloating every session prompt. A new read-only action alongside the existing eleven. |

The gotcha list is the highest-value part and is stated plainly: `node` is not on
PATH on debian10; `python3` on PATH is not the 3.10.9; `custom` is Debian 9 with
Node 10.16.2 and Python 3.7.4; layers mount under `/opt` while base interpreters
live under `/var/fc/lang`; a build host's `pip` targets the host unless told
otherwise.

## 6. The contract

### 6.1 Short form — for apps whose start is just an interpreter and a file

```jsonc
{
  "build": { "kind": "node", "output": ".output" },
  "start": { "entry": "server/index.mjs", "port": 9000 }
}
```

`entry` is a path inside the code package (the zipped `build.output`), not the
repo; it must stay inside it. `port` defaults to 9000. A missing `entry` for a
kind that needs one is an error, never an inferred default.

| kind | fcRuntime | interpreter | layers | provenance |
|---|---|---|---|---|
| node | `custom.debian10` | `/var/fc/lang/nodejs20/bin/node` | none | **deployed, served 200** |
| go | `custom.debian10` | `./main` | none | `go` absent from image; build emits a static `linux/amd64` binary. Untested. |
| container | `custom-container` | — | none | unchanged |

**`python`, `php` and `java` have no short form.** Python's real shape is
`python3 -m uvicorn app.main:app --host 0.0.0.0 --port 9000` with an
app-specific `PYTHONPATH` — a module target and an import path that no profile
can know. `php` and `java` need a layer whose mount path is unverified. Those
kinds use §6.2, which is not a penalty: it is the normal road.

### 6.2 Informed passthrough — everything real

Unchanged fields (`fcRuntime`, `command`, `args`, `port`, `layers`,
`healthCheckPath`), now written against §5 rather than against a guess. Layers
may be named region-free as `Name:version`; the platform supplies the region.

Declaring both forms at once is an error, not a precedence rule.

## 7. Preflight

Applies to both forms, before any call to Alibaba.

| | rule | verdict | basis |
|---|---|---|---|
| R1 | official ARN's region ≠ deploy region | refuse, naming the deploy region and the shorthand | FC refuses it a round-trip later, naming no usable region |
| R2 | command reaches into `/opt/<x>` with no attached layer mounting it | refuse | `/opt` held nothing but the attached layer (§2.1) |
| R3 | bare interpreter the image does not put on PATH (`node` on debian10) | refuse | `PROBE-PATH node MISSING` |
| R3b | bare interpreter on `custom` (Debian 9) — present but ancient | warn | `james-test1` serves traffic on 3.7.4 today; refusing would block a working deploy to protect it from a hazard it has already survived |
| R4 | bare `python3` on `custom.debian10` | warn | resolves to `/usr/bin/python3`, not 3.10.9 |

R1–R3 are `ApiError(400, "validation_failed", …)`. Warnings go to the control
plane log (`app-deploy.ts:507` precedent); if §10's diagnosability gap is fixed
by surfacing deploy warnings to the caller, they should move to that channel.

A layer whose mount path is unverified makes R2 step aside rather than guess.

## 8. Non-goals

- **Platform-owned `pip` flags.** §2.3 shows the fix, but the correct flags are
  target-specific and belong in `build.command`, which the agent writes with
  §4.3 in hand. A platform that injected them would also have to own the
  no-wheel failure mode for every language. Publishing the target is the smaller
  and more general answer.
- **Issue 4, local Docker.** Publishing `docker: not available` (§4.2) removes
  the four wasted commits; actually building images without Docker is a
  different subsystem.
- **Built-in FC runtimes.** Never established whether `runtime: "nodejs20"`
  accepts `customRuntimeConfig`; moot now that `custom.debian10` supplies current
  Node and Python.
- **A Python template.** Worth doing; not this spec.

## 9. Open questions

1. **php and java mount paths are unverified**, so no short form and R2 steps
   aside for them.
2. **Go's static-binary assumption is untested.**
3. Facts are hand-verified constants, not introspected live. **They can go
   stale.** A preflight failing on something the facts claimed is the signal to
   re-probe.

## 10. Known defects this work does not fix

Recorded because both were found while doing it and both make everything else
harder to diagnose.

- **A deploy can fail with no recoverable reason.** A deploy reached
  `fcStatus: deploy_error` with no reason on the app record (every key
  enumerated), nothing from the logs endpoint, and nothing in the daemon log.
  `deployError` exists in the OpenAPI contract but `GET /v1/apps/{id}` does not
  return it.
- **`build.command` has no Windows path.** It runs as `sh -c` with no
  `target_os` branch, so a custom build command may be silently undeployable
  from a third of this team's devices, and nothing warns anyone.
- **The deploy confirmation modal is easy to miss** and blocks until answered;
  it appears to have silently swallowed two deploy attempts during this work.

## 11. Migration

Nothing is rewritten and nothing breaks. Existing passthrough repos — all five
apps here — keep deploying byte-identically. Short-form resolution applies only
when `entry` is present, and **live apps are never silently re-profiled**.

`defaultLayersForKind` and `LAYER_VERSIONS` are untouched: they serve the
passthrough form, where omitting `layers` still yields the pinned `Nodejs20`
ARN. Repointing them at the short-form table would strip the layer from every
existing repo that omits the field.

| Target | Action |
|---|---|
| Templates ×3 | Short form |
| Template `AGENTS.md` ×3 | Intent vocabulary; portability constraint |
| OpenAPI | `AppStartSpec` gains `entry`; `port` optional |
| Agent prompt | Facts summary + gotchas + portability constraint |
| `manage_app` | New read-only `runtime_info` action |
| `app_build.rs` | `entry: Option<String>`; `port` default 9000; `entry` inside the package |
| Daemon session prompt | Host facts, derived per session |

## 12. Testing

- One test per short-form profile row, asserting the exact verified strings.
- Regression: the live apps' current `start_spec` values must parse to
  themselves.
- One test per preflight rule, each asserting the message names the fix.
- Mixed-form rejection.
- Round-trip: short form → expansion → byte-identical to what `runtimeInput`
  builds today for the equivalent passthrough config.
- Facts publication: the prompt contains the region, this host's OS/arch and the
  gotcha list; `runtime_info` returns provenance for every row.

Tests cannot reach Function Compute. Unverified rows stay unverified until
someone deploys them; the tests pin the constants, not their truth.
