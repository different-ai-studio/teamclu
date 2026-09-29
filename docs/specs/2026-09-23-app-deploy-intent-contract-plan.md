# App Deploy: Published Facts + Declared Intent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish what only the platform can know — the deploy region, what the runtime image contains, this build host's OS and tooling — so the agent writes a deploy config from facts instead of guesses, with a preflight as the backstop.

**Architecture:** Three fact kinds kept apart by scope: runtime facts (app-scoped, control plane), host facts (session-scoped, daemon), and the portability constraint derived from the second. A short form survives only for apps whose start really is `<interpreter> <entry>`. Everything else uses the passthrough form, now informed.

**Tech Stack:** TypeScript (`node:test` + `tsx`) in `services/fc`; Rust in `apps/daemon` and `apps/desktop`; OpenAPI 3 YAML.

**Spec:** `docs/specs/2026-09-23-app-deploy-intent-contract-design.md` (rewritten at commit `0025d98e`)

## Status: this plan continues committed work

Eight commits on `design/app-deploy-intent-contract` implement the superseded
D1′ design. Most survives. Do **not** start from `main`.

| Already committed | Still correct? |
|---|---|
| `6047991b` facts table + helpers | Yes, but Task 1 splits it |
| `23dd28b2` layer shorthand + region refusal (R1) | Yes, unchanged |
| `17c7aaca` short form + `resolveIntent` + OpenAPI | Partly — Task 1 removes python/php/java |
| `02b66cdf` preflight R2/R3/R3b/R4 | Yes; Task 1 re-points R4's source |
| `3b8562bc` daemon `entry` + port default | Yes, unchanged |
| `8b8f03b1` templates + AGENTS.md + prompt | Prompt text rewritten in Task 6 |
| `fc968c38` frontend `AppStartSpec` | Yes, unchanged |

## Global Constraints

- **Never break an existing repo.** All five live apps use the passthrough form and must keep deploying byte-identically. The regression tests in `app-runtime-spec.test.ts` pin this — never weaken them.
- **`LAYER_VERSIONS` / `defaultLayersForKind` stay as they are.** They serve the passthrough form; repointing them strips layers from repos that omit the field. (Spec §11.)
- **Facts carry provenance** (spec D5). An unverified mount path is published as unverified. Never publish a confident guess.
- **Host facts never reach the app row or the server-side snapshot** (spec D4). The same app builds on two Macs and a Windows box in this team.
- **Exact verified strings** — these are the design; copy them character for character:
  - `/var/fc/lang/nodejs20/bin/node` (v20.10.0), `/var/fc/lang/nodejs18/bin/node` (v18.19.0)
  - `/var/fc/lang/python3.10/bin/python3` (3.10.9)
  - `custom.debian10` is Debian 10.13, `x86_64`; `node` absent from PATH; `python3` → `/usr/bin/python3`
- **Out of scope** (spec §8): platform-owned `pip` flags, building images without Docker, built-in FC runtimes, a Python template.
- **Branch:** `design/app-deploy-intent-contract`. Do not push or open a PR without being asked.
- Commands: `cd services/fc && node --import tsx --test "test/**/*.test.ts"`; `npx tsc --noEmit -p tsconfig.test.json`; `cargo test -p amuxd --bin amuxd <filter>`; `pnpm rust:check`; `pnpm typecheck`.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/fc/src/lib/provisioning/app-runtime-profiles.ts` *(modify)* | Split: image **facts** (all interpreters, PATH behaviour, layer mounts) from **short-form profiles** (node, go only). Add the publishable payload builder. |
| `services/fc/src/lib/provisioning/app-runtime-spec.ts` *(modify)* | `resolveIntent` refuses kinds with no short-form profile; R4 reads the facts, not a profile. |
| `services/fc/src/lib/supabase-repo.ts` *(modify)* | App snapshot carries runtime facts. |
| `services/fc/src/lib/business-api.mjs` + route *(modify)* | `GET /v1/apps/:appId/runtime-info`. |
| `apps/daemon/src/backend/records.rs` *(modify)* | `SessionAppContext` carries the runtime facts blob. |
| `apps/daemon/src/runtime/host_facts.rs` *(new)* | This machine: OS, arch, docker, build shell. Session-scoped. |
| `apps/daemon/src/runtime/session_prompt.rs` *(modify)* | Render facts + gotchas + the portability constraint. |
| `apps/desktop/src/commands/introspect_api/apps.rs` *(modify)* | `manage_app runtime_info`. |
| `templates/*/AGENTS.md` *(modify)* | Portability constraint. |

---

### Task 1: Split image facts from short-form profiles

Python's real start is `python3 -m uvicorn app.main:app` with an app-owned
`PYTHONPATH`; no profile can express it. But Python's *interpreter path* is
still a fact R4 needs. One table cannot be both.

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-runtime-profiles.ts`
- Modify: `services/fc/src/lib/provisioning/app-runtime-spec.ts` (`resolveIntent`, `checkStartEnvironment`)
- Test: `services/fc/test/provisioning/app-runtime-profiles.test.ts`, `app-runtime-spec.test.ts`

**Interfaces:**
- Produces: `IMAGE_INTERPRETERS: Record<string, Record<string, Interpreter>>` where `Interpreter = { path: string; version: string }`; `SHORT_FORM_PROFILES: Record<"node"|"go", RuntimeProfile>`; `shortFormProfile(kind): RuntimeProfile | null`; `interpreterFor(fcRuntime, family): Interpreter | null`.
- Removes: `RUNTIME_PROFILES` (and its `verified` flag — a kind either has a profile or does not).

- [ ] **Step 1: Write the failing tests**

Replace the three `profiles:` tests in `app-runtime-profiles.test.ts` with:

```ts
test("facts: the image's interpreters, by family, with absolute paths", () => {
  assert.deepEqual(interpreterFor("custom.debian10", "node"), {
    path: "/var/fc/lang/nodejs20/bin/node",
    version: "20.10.0",
  });
  assert.deepEqual(interpreterFor("custom.debian10", "python"), {
    path: "/var/fc/lang/python3.10/bin/python3",
    version: "3.10.9",
  });
  // A family the image does not ship is a fact too, and it is "no".
  assert.equal(interpreterFor("custom.debian10", "java"), null);
});

test("short form: only node and go have one", () => {
  assert.equal(shortFormProfile("node")?.interpreter, "/var/fc/lang/nodejs20/bin/node");
  assert.equal(shortFormProfile("go")?.interpreter, "./main");
  for (const kind of ["python", "php", "java"] as const) {
    assert.equal(shortFormProfile(kind), null, kind);
  }
});

test("short form: node needs an entry, go does not", () => {
  assert.equal(shortFormProfile("node")?.entryRequired, true);
  assert.equal(shortFormProfile("go")?.entryRequired, false);
  assert.deepEqual(shortFormProfile("node")?.layers, []);
});
```

In `app-runtime-spec.test.ts`, replace the `intent: php and java are refused…`
test with:

```ts
test("intent: kinds with no short form are refused, and say where to go", () => {
  for (const kind of ["python", "php", "java"] as const) {
    assert.throws(
      () => parseAppDeployDeclaration({ build: { kind }, start: { entry: "app", port: 9000 } }),
      (e: any) => {
        const m = String(e?.message ?? e);
        return m.includes(kind) && /fcRuntime/.test(m) && /command/.test(m);
      },
      kind,
    );
  }
});

test("preflight: bare python3 on debian10 still names the interpreter it is not", () => {
  // Python has no short-form profile any more; this warning reads the facts.
  const warnings = checkStartEnvironment(
    { kind: "python", output: "." },
    { fcRuntime: "custom.debian10", command: ["python3"], args: ["app.py"], port: 9000, layers: [] },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/usr\/bin\/python3/);
  assert.match(warnings[0], /\/var\/fc\/lang\/python3\.10\/bin\/python3/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd services/fc && node --import tsx --test "test/provisioning/*.test.ts"`
Expected: FAIL — `interpreterFor` and `shortFormProfile` are not exported.

- [ ] **Step 3: Restructure the module**

In `app-runtime-profiles.ts`, replace the `RUNTIME_PROFILES` block with:

```ts
/** One interpreter the base image ships, at a path that does not move. */
export interface Interpreter {
  path: string;
  version: string;
}

/**
 * What each image ships, keyed by language family.
 *
 * These are facts, published to the agent — not choices. A family absent from
 * an image is itself a fact, and `interpreterFor` answers `null` for it.
 */
export const IMAGE_INTERPRETERS: Record<string, Record<string, Interpreter>> = {
  "custom.debian10": {
    node: { path: "/var/fc/lang/nodejs20/bin/node", version: "20.10.0" },
    node18: { path: "/var/fc/lang/nodejs18/bin/node", version: "18.19.0" },
    python: { path: "/var/fc/lang/python3.10/bin/python3", version: "3.10.9" },
  },
};

export function interpreterFor(fcRuntime: string, family: string): Interpreter | null {
  return IMAGE_INTERPRETERS[fcRuntime]?.[family] ?? null;
}

/** Debian version per image, for messages that need to name it. */
export const IMAGE_DEBIAN: Record<string, string> = {
  "custom.debian10": "10.13",
  custom: "9",
};

export interface RuntimeProfile {
  fcRuntime: string;
  interpreter: string;
  argsFor: "entry" | "none";
  layers: string[];
  entryRequired: boolean;
}

/**
 * Kinds whose start really is `<interpreter> <entry>`.
 *
 * Python is deliberately absent: its real shape is
 * `python3 -m uvicorn app.main:app` with an import path the app's own build
 * decides, which no table can own. PHP and Java are absent because their
 * interpreter lives in a layer whose mount path has never been observed.
 * Those kinds use the passthrough form, which is the normal road and not a
 * penalty.
 */
export const SHORT_FORM_PROFILES: Record<string, RuntimeProfile> = {
  node: {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/nodejs20/bin/node",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
  },
  go: {
    fcRuntime: "custom.debian10",
    interpreter: "./main",
    argsFor: "none",
    layers: [],
    entryRequired: false,
  },
};

export function shortFormProfile(kind: string): RuntimeProfile | null {
  return SHORT_FORM_PROFILES[kind] ?? null;
}
```

In `app-runtime-spec.ts`, change the import from `RUNTIME_PROFILES` to
`{ interpreterFor, shortFormProfile }` and rewrite the two uses.

`resolveIntent`:

```ts
  const profile = shortFormProfile(kind);
  if (!profile) {
    throw new ApiError(
      400,
      "validation_failed",
      `build.kind "${kind}" has no short form: how it starts depends on the app, not the language. Declare fcRuntime, command, args and layers — call manage_app runtime_info for the interpreter paths and layers available to you.`,
    );
  }
```

In `checkStartEnvironment`, replace every `profile?.verified ? profile.interpreter : …`
with a facts lookup, so a kind without a short form still gets a useful message:

```ts
  const family = build.kind === "node" ? "node" : build.kind;
  const shipped = interpreterFor(start.fcRuntime ?? "", family);
  const alternative = shipped
    ? shipped.path
    : "an absolute path to the interpreter you mean";
```

and in the R4 advisory compare against `shipped?.path`:

```ts
    if (found.kind === "resolves" && shipped && found.path !== shipped.path) {
      warnings.push(
        `${where} runs "${program.basename}", which resolves to ${found.path} on ${fcRuntime} — not ${shipped.path}. The function will run ${found.version}.`,
      );
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd services/fc && node --import tsx --test "test/provisioning/*.test.ts"`
Expected: PASS. The two regression tests must still pass untouched.

- [ ] **Step 5: Typecheck and commit**

```bash
cd services/fc && npx tsc --noEmit -p tsconfig.test.json
cd /Users/dengwei/git/teamclu
git add services/fc/src/lib/provisioning services/fc/test/provisioning
git commit -m "refactor(apps): 镜像事实和短格式 profile 分家，python 回到直通格式"
```

---

### Task 2: The publishable facts payload

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-runtime-profiles.ts`
- Test: `services/fc/test/provisioning/app-runtime-profiles.test.ts`

**Interfaces:**
- Consumes: Task 1's tables.
- Produces: `runtimeFacts(region: string): RuntimeFacts` — a JSON-serialisable object published in two places (Tasks 3 and 5).

- [ ] **Step 1: Write the failing test**

```ts
test("facts payload: names the region, the target, and its own gaps", () => {
  const f = runtimeFacts("cn-shenzhen");
  assert.equal(f.region, "cn-shenzhen");
  assert.equal(f.target.os, "linux");
  assert.equal(f.target.arch, "x86_64");

  const d10 = f.images["custom.debian10"];
  assert.equal(d10.debian, "10.13");
  assert.equal(d10.interpreters.node.path, "/var/fc/lang/nodejs20/bin/node");
  // The trap, published rather than discovered.
  assert.deepEqual(d10.onPath.node, { resolves: null });
  assert.equal(d10.onPath.python3.resolves, "/usr/bin/python3");

  // Provenance, including the gaps.
  assert.equal(f.layers.Nodejs20.mount, "/opt/nodejs20");
  assert.equal(f.layers.Nodejs20.verified, true);
  assert.equal(f.layers.Java17.mount, null);
  assert.equal(f.layers.Java17.verified, false);

  assert.ok(f.gotchas.some((g: string) => /not on PATH/.test(g)));
  assert.ok(f.gotchas.some((g: string) => /\/usr\/bin\/python3/.test(g)));
});

test("facts payload: region is the only thing that varies", () => {
  const a = runtimeFacts("cn-shenzhen");
  const b = runtimeFacts("cn-beijing");
  assert.notEqual(a.region, b.region);
  assert.deepEqual(a.images, b.images);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-profiles.test.ts`
Expected: FAIL — `runtimeFacts is not a function`.

- [ ] **Step 3: Implement**

```ts
export interface RuntimeFacts {
  region: string;
  target: { os: "linux"; arch: "x86_64" };
  codePath: string;
  images: Record<
    string,
    {
      debian: string;
      interpreters: Record<string, Interpreter>;
      onPath: Record<string, { resolves: string | null; version?: string }>;
    }
  >;
  layers: Record<string, { mount: string | null; verified: boolean }>;
  gotchas: string[];
}

/**
 * Everything the platform knows about where an app will run, in the shape the
 * agent reads it.
 *
 * Hand-verified constants, not live introspection — so a preflight failing on
 * something stated here is the signal to re-probe the image, not to work
 * around the message.
 */
export function runtimeFacts(region: string): RuntimeFacts {
  const images: RuntimeFacts["images"] = {};
  for (const fcRuntime of Object.keys(IMAGE_DEBIAN)) {
    const onPath: RuntimeFacts["images"][string]["onPath"] = {};
    for (const [name, lookup] of Object.entries(PATH_INTERPRETERS[fcRuntime] ?? {})) {
      onPath[name] =
        lookup.kind === "resolves"
          ? { resolves: lookup.path, version: lookup.version }
          : { resolves: null };
    }
    images[fcRuntime] = {
      debian: IMAGE_DEBIAN[fcRuntime],
      interpreters: IMAGE_INTERPRETERS[fcRuntime] ?? {},
      onPath,
    };
  }
  const layers: RuntimeFacts["layers"] = {};
  for (const [name, mount] of Object.entries(LAYER_MOUNTS)) {
    layers[name] = { mount: mount ?? null, verified: mount !== null };
  }
  return {
    region,
    target: { os: "linux", arch: "x86_64" },
    codePath: "/code",
    images,
    layers,
    gotchas: [
      "custom.debian10 already ships Node 20 and Python 3.10 — the Nodejs20 and Python310 layers are redundant on it.",
      "`node` is not on PATH in custom.debian10. Reach an interpreter by its absolute path.",
      "`python3` on PATH in custom.debian10 is /usr/bin/python3, NOT the 3.10.9 in /var/fc/lang — using the bare name downgrades silently.",
      "fcRuntime \"custom\" is Debian 9: Node 10.16.2 and Python 3.7.4, too old for most current packages.",
      "Layers mount under /opt; the image's own interpreters live under /var/fc/lang.",
      "A layer ARN is region-scoped. Write \"Name:version\" and the platform fills in the region.",
    ],
  };
}
```

- [ ] **Step 4: Run, typecheck, commit**

```bash
cd services/fc && node --import tsx --test test/provisioning/app-runtime-profiles.test.ts \
  && npx tsc --noEmit -p tsconfig.test.json
cd /Users/dengwei/git/teamclu
git add services/fc/src/lib/provisioning/app-runtime-profiles.ts services/fc/test/provisioning/app-runtime-profiles.test.ts
git commit -m "feat(apps): 把运行时事实整理成可以发给 agent 的结构"
```

---

### Task 3: Runtime facts reach the agent's prompt

The app snapshot is assembled server-side in the same process as the facts, so
this is plumbing, not duplication.

**Files:**
- Modify: `services/fc/src/lib/supabase-repo.ts` (the `appContext = {` block)
- Modify: `apps/daemon/src/backend/records.rs`
- Test: `apps/daemon/src/runtime/session_prompt.rs` (inline tests)

**Interfaces:**
- Consumes: `runtimeFacts` (Task 2), `appsRegion()`.
- Produces: `SessionAppContext.runtime: Option<serde_json::Value>`, rendered inside the existing `<teamclu_app_context_data>` block.

- [ ] **Step 1: Write the failing test**

In `session_prompt.rs`'s test module, extend
`app_workspace_prompt_includes_safe_snapshot_manifest_and_policy`'s JSON with a
`"runtime"` key and assert it renders:

```rust
    #[test]
    fn app_workspace_prompt_publishes_runtime_facts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("teamclu.app.json"),
            r#"{"build":{"kind":"node"},"start":{"entry":"server/index.mjs"}}"#,
        )
        .unwrap();
        let app: SessionAppContext = serde_json::from_value(serde_json::json!({
            "snapshotAt": "2026-09-24T10:00:00.000Z",
            "id": "app-1", "name": "demo", "type": "static_web", "visibility": "personal",
            "provisionStatus": "ready", "fcStatus": "live",
            "deployment": {"runtime": "node", "startSpec": null},
            "runtime": {
                "region": "cn-shenzhen",
                "target": {"os": "linux", "arch": "x86_64"},
                "gotchas": ["`node` is not on PATH in custom.debian10."]
            },
            "auth": {"mode": "none", "audience": "org", "scope": "all", "rules": []},
            "database": {"configured": false, "live": false},
            "storage": {"controlPlaneAvailable": false, "overQuota": false},
            "environment": {"keys": []},
            "customDomain": {"domain": null, "verified": false}
        }))
        .unwrap();

        let text = build_app_workspace_prompt(&app, dir.path().to_str().unwrap());
        assert!(text.contains("cn-shenzhen"), "region must be published");
        assert!(text.contains("x86_64"), "target arch must be published");
        assert!(text.contains("not on PATH"), "gotchas must be published");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p amuxd --bin amuxd runtime::session_prompt`
Expected: FAIL — `unknown field 'runtime'` or the assertions miss.

- [ ] **Step 3: Carry the facts through**

`records.rs`, on `SessionAppContext`:

```rust
    /// Runtime facts published by the control plane: region, target platform,
    /// what each image ships and where. Host facts are NOT here — they belong
    /// to whichever machine runs the build, which may not be this one.
    #[serde(default)]
    pub runtime: Option<serde_json::Value>,
```

`supabase-repo.ts`, inside `appContext = {` beside `deployment`:

```ts
              // Host-independent and true wherever the build ran. Host facts
              // (OS, arch, docker) are the daemon's to add: the same app is
              // built on macOS and Windows by different teammates.
              runtime: runtimeFacts(appsRegion()),
```

with `import { runtimeFacts } from "./provisioning/app-runtime-profiles.js";`
and `appsRegion` already imported in that module's provisioning helpers.

No change is needed in `build_app_workspace_prompt`: it serialises
`controlPlaneSnapshot` wholesale, so a new field appears automatically.

- [ ] **Step 4: Run, check, commit**

```bash
cargo test -p amuxd --bin amuxd runtime::session_prompt
cd services/fc && npx tsc --noEmit -p tsconfig.test.json
cd /Users/dengwei/git/teamclu && pnpm rust:check
git add services/fc/src/lib/supabase-repo.ts apps/daemon/src/backend/records.rs apps/daemon/src/runtime/session_prompt.rs
git commit -m "feat(apps): 运行时事实随应用快照发到 agent 的提示里"
```

---

### Task 4: Host facts and the portability constraint

**Files:**
- Create: `apps/daemon/src/runtime/host_facts.rs`
- Modify: `apps/daemon/src/runtime/mod.rs` (declare the module)
- Modify: `apps/daemon/src/runtime/session_prompt.rs`

**Interfaces:**
- Produces: `host_facts() -> serde_json::Value` with `os`, `arch`, `docker`, `buildShell`.

- [ ] **Step 1: Write the failing test**

In `host_facts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_facts_describe_this_machine_not_the_app() {
        let f = host_facts();
        // Whatever machine runs this test, these must be populated: the agent
        // reads them to decide whether a build command is even runnable here.
        assert!(f["os"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(f["arch"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(f["docker"].is_boolean());
        assert_eq!(f["buildShell"], "sh -c");
    }

    #[test]
    fn host_facts_name_the_real_os() {
        let f = host_facts();
        let os = f["os"].as_str().unwrap();
        assert!(
            ["macos", "windows", "linux"].contains(&os),
            "unexpected os {os}"
        );
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p amuxd --bin amuxd runtime::host_facts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/daemon/src/runtime/host_facts.rs`:

```rust
//! What is true of *this* machine, for the session prompt.
//!
//! Deliberately not app state. The same app is checked out on two macOS
//! machines and a Windows machine in one team here, and whichever teammate
//! deploys is the one whose tools run. A host fact stored on the app row would
//! be wrong for two thirds of them.

use serde_json::{json, Value};

/// This machine, as the agent needs to see it.
pub fn host_facts() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "docker": crate::runtime::well_known_bin::find_in_path("docker", None).is_some(),
        // `build.command` is run as `sh -c <command>` with no Windows branch;
        // see app_build.rs. Published so the agent can see the shell it is
        // writing for.
        "buildShell": "sh -c",
    })
}
```

Declare it in `apps/daemon/src/runtime/mod.rs`:

```rust
pub mod host_facts;
```

In `session_prompt.rs`, add host facts to the data block and the contract:

```rust
    let data = serde_json::json!({
        "controlPlaneSnapshot": app,
        "checkoutDeclaration": declaration,
        "thisMachine": crate::runtime::host_facts::host_facts(),
    });
```

and these contract lines:

```
- `thisMachine` describes the machine running this session, not the app. Another teammate may deploy the same commit from a different OS.
- `build.command` is committed to the repository and will also run on their machines, through `sh -c`. Write commands that do not depend on this machine: flags naming the *target* (for Python, `pip install --platform manylinux2014_x86_64 --implementation cp --python-version 3.10 --only-binary=:all: -t <dir>`) are identical everywhere, while `rm -rf`, `brew` and backslash paths are not.
- The build runs here and the function runs on `controlPlaneSnapshot.runtime.target` (linux/x86_64). Anything compiled during the build must be built for that target, not for `thisMachine`.
```

- [ ] **Step 4: Run, check, commit**

```bash
cargo test -p amuxd --bin amuxd runtime::host_facts runtime::session_prompt
cargo fmt --check --manifest-path apps/daemon/Cargo.toml || rustfmt --edition 2021 apps/daemon/src/runtime/host_facts.rs
pnpm rust:check
git add apps/daemon/src/runtime
git commit -m "feat(daemon): 会话提示里发布本机事实和可移植性约束"
```

---

### Task 5: `manage_app runtime_info`

Detail on demand, without bloating every prompt. The control plane owns the
facts, so the action fetches them rather than keeping a second copy.

**Files:**
- Modify: `docs/openapi/teamclu-api.v1.yaml` (new `GET /v1/apps/{appId}/runtime-info`)
- Modify: `services/fc/src/lib/business-api.mjs` (route)
- Modify: `apps/desktop/src/commands/introspect_api/apps.rs` (`MANAGE_ACTIONS`, dispatch, handler)
- Test: `services/fc/test/app-v1.test.ts`; `apps.rs` inline tests

**Interfaces:**
- Consumes: `runtimeFacts` (Task 2), `host_facts` (Task 4, via the daemon's own reporting — the desktop computes its own).
- Produces: action `runtime_info` returning `{ action, runtime, thisMachine }`.

- [ ] **Step 1: Write the failing test**

In `apps.rs`'s test module:

```rust
    #[test]
    fn runtime_info_is_a_known_read_only_action() {
        assert!(MANAGE_ACTIONS.contains(&"runtime_info"));
        // Read-only: it must never be in the set that asks for confirmation.
        assert!(!["deploy", "delete"].contains(&"runtime_info"));
    }
```

In `services/fc/test/app-v1.test.ts`, add a route test following the file's
existing pattern for a GET under `/v1/apps/:id`, asserting the body contains
`region`, `target.arch === "x86_64"` and a non-empty `gotchas` array.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p amuxd --bin amuxd runtime_info_is_a_known` and
`cd services/fc && node --import tsx --test test/app-v1.test.ts`
Expected: both FAIL.

- [ ] **Step 3: Implement**

Add `"runtime_info"` to `MANAGE_ACTIONS` (making it `[&str; 12]`), and to the
read-only dispatch arm:

```rust
        "runtime_info" => json!({
            "action": "runtime_info",
            "runtime": api.runtime_info(&app_id).await?,
            "this_machine": host_facts_json(),
        }),
```

where `host_facts_json()` mirrors Task 4's fields for the desktop process
(`std::env::consts::OS` / `ARCH`).

Serve the facts from the control plane:

```js
// business-api.mjs — beside the other /v1/apps/:appId routes
route("GET", "/v1/apps/:appId/runtime-info", async (ctx) => {
  await requireAppReader(ctx);          // same gate as the logs endpoint
  return json(runtimeFacts(appsRegion()));
});
```

and document it in the OpenAPI file next to `/v1/apps/{appId}/logs`.

- [ ] **Step 4: Run, lint, commit**

```bash
cargo test -p amuxd --bin amuxd runtime_info
cd services/fc && node --import tsx --test test/app-v1.test.ts && pnpm openapi:lint
cd /Users/dengwei/git/teamclu
git add docs/openapi services/fc apps/desktop/src/commands/introspect_api/apps.rs
git commit -m "feat(apps): manage_app runtime_info 按需返回完整的运行时事实"
```

---

### Task 6: Align the authoring surface

**Files:**
- Modify: `templates/{slides,static-web,tanstack-postgres}/AGENTS.md`
- Modify: `apps/daemon/src/runtime/session_prompt.rs` (the contract lines Task 6 of the previous plan added)

**Interfaces:** none; copy only.

- [ ] **Step 1: Write the failing test**

In `app_templates.rs`'s test module:

```rust
    #[test]
    fn agents_md_warns_that_build_command_runs_on_teammates_machines() {
        for t in [AppType::StaticWeb, AppType::Slides, AppType::DataApp] {
            let tmp = seed(t);
            let agents = std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap();
            assert!(agents.contains("队友"), "{t:?}: portability constraint missing");
            assert!(agents.contains("runtime_info"), "{t:?}: facts pointer missing");
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p amuxd --bin amuxd agents_md_warns`
Expected: FAIL.

- [ ] **Step 3: Update the copy**

In each `AGENTS.md`, after the existing deploy-declaration bullets:

```markdown
- 不确定运行环境里有什么，就调用 `manage_app` 的 `runtime_info`：它会告诉你部署区域、镜像自带哪些解释器（绝对路径和版本）、PATH 上的裸名字实际指向谁、以及可用的层。不要猜这些值——十二个修复 commit 就是猜出来的。
- `build.command` 会随仓库提交，**在队友的机器上也会跑**（这个团队里就有 Windows），而且是用 `sh -c` 跑的。所以要写「指定目标」的命令：Python 装依赖用 `pip install --platform manylinux2014_x86_64 --implementation cp --python-version 3.10 --only-binary=:all: -t lib/`，这在哪台机器上跑结果都一样；`rm -rf`、`brew`、反斜杠路径则不行。
```

Then trim the previous plan's prompt lines that described the platform
*choosing* the runtime, leaving Task 4's fact-based lines.

- [ ] **Step 4: Run the full suites and commit**

```bash
cargo test -p amuxd --bin amuxd
cd services/fc && node --import tsx --test "test/**/*.test.ts"
cd /Users/dengwei/git/teamclu && pnpm typecheck && pnpm test:unit
git add templates apps/daemon/src/runtime/session_prompt.rs apps/daemon/src/sync/app_templates.rs
git commit -m "docs(apps): 模板告诉 agent 去问事实，并警告构建命令要跨机器可用"
```

---

## Self-Review

**Spec coverage.** §4.1 runtime facts → Tasks 1, 2, 3. §4.2 host facts → Task 4.
§4.3 portability constraint → Tasks 4 and 6. §5 publication surfaces → Task 3
(prompt) and Task 5 (`runtime_info`). §6.1 short form → Task 1 (node/go only).
§6.2 passthrough → already committed, unchanged. §7 preflight → already
committed; Task 1 re-points R4 at the facts. §11 migration → Tasks 1 and 6, with
the existing regression tests unchanged. §12 testing → distributed.

**Not covered, deliberately.** §8 non-goals stay out. §9's unverified rows stay
unverified — they are published *as* unverified, which is the whole point of D5.
§10's three defects (invisible `deploy_error`, no Windows build path, the easily
missed confirm modal) are recorded, not fixed; the Windows one is now at least
*disclosed* to the agent by Task 4's `buildShell`, which is disclosure, not a
fix.

**Gap found during review.** Task 5 needs a control-plane endpoint because the
introspect API is Rust in the desktop process while the facts are TypeScript in
the control plane. Copying the table into Rust would create exactly the drift
D5 is meant to prevent, so the action fetches. That is one more moving part than
the spec's §5 table implies, and it is the honest cost of one source of truth.

**Type consistency.** `Interpreter { path, version }` is identical in Tasks 1, 2
and the tests. `RuntimeProfile` loses `verified` in Task 1 and no later task
references it. `shortFormProfile` returns `RuntimeProfile | null` and every
caller null-checks. `runtimeFacts(region)` has one signature, used by Tasks 3
and 5. `host_facts()` returns `serde_json::Value` with the four keys asserted in
Task 4 and consumed in Task 5.
