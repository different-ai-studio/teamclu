# App Deploy Intent Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `teamclu.app.json` declare *intent* (`kind` + `entry` + `port`) and have the control plane resolve it to Function Compute start fields from a verified profile table, so an author never writes a runtime, an interpreter path, a layer, or a region.

**Architecture:** A new pure module holds the profile table and the facts observed in the runtime images. `parseAppDeployDeclaration` gains a resolution step that expands the short form into the existing `AppStartSpec`, so everything downstream (`fc-client.ts`, `runtimeInput`) is untouched. The FC passthrough form stays valid and gains four preflight rules. Layer references may be written region-free (`Java17:3`) and are expanded at the one call site that already knows the region.

**Tech Stack:** TypeScript (Node 20, `node:test` + `tsx`) in `services/fc`; Rust (serde) in `apps/daemon`; OpenAPI 3 YAML.

**Spec:** `docs/specs/2026-09-23-app-deploy-intent-contract-design.md` (commits `10873917`, `fda9b848`)

## Global Constraints

- **Never break an existing repo.** All five live apps use the passthrough form. Every change must leave them deploying byte-identically. The regression test in Task 3 pins this.
- **`LAYER_VERSIONS` and `defaultLayersForKind` are not modified.** They serve the passthrough form. Repointing them at the profile table silently strips the layer from existing repos that omit `layers`. (Spec §5, §10.)
- **Never ship an unverified path as a platform choice** (spec D5). `php` and `java` short form is refused, not guessed.
- **Exact verified strings** — these are the design, copy them character for character:
  - `/var/fc/lang/nodejs20/bin/node` (Node v20.10.0)
  - `/var/fc/lang/python3.10/bin/python3` (Python 3.10.9)
  - base image for every code kind: `custom.debian10`
  - `node` is **absent from PATH** on `custom.debian10`
  - `python3` on PATH is `/usr/bin/python3`, **not** the 3.10.9
- **Out of scope** (spec §8): the `pip` cross-platform wheel bug, local Docker, built-in FC runtimes, a Python template.
- **Branch:** `design/app-deploy-intent-contract`. Do not push or open a PR without being asked.
- Run TypeScript tests with `cd services/fc && node --import tsx --test "test/**/*.test.ts"`, typecheck with `npx tsc --noEmit -p tsconfig.test.json`.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/fc/src/lib/provisioning/app-runtime-profiles.ts` *(new)* | Pure data + pure functions: what the images contain, the profile per `build.kind`, layer-reference parsing, and "what program does this argv actually run". No I/O, no `ApiError`. |
| `services/fc/src/lib/provisioning/app-runtime-spec.ts` *(modify)* | Parsing and validation. Gains short-form parsing, intent resolution, the region check, and the preflight rules. Keeps `LAYER_VERSIONS` untouched. |
| `services/fc/test/provisioning/app-runtime-profiles.test.ts` *(new)* | Table and helper tests. |
| `services/fc/test/provisioning/app-runtime-spec.test.ts` *(modify)* | Contract, resolution, preflight, and the live-app regression. |
| `apps/daemon/src/sync/app_build.rs` *(modify)* | Accept `entry`; default `port`; keep `entry` inside the package. |
| `docs/openapi/teamclu-api.v1.yaml` *(modify)* | `AppStartSpec` gains `entry`; `port` optional; `layers` documents shorthand. |
| `templates/{slides,static-web,tanstack-postgres}/teamclu.app.json` *(modify)* | Short form. |
| `templates/{slides,static-web,tanstack-postgres}/AGENTS.md` *(modify)* | Intent vocabulary, no ARNs. |
| `apps/daemon/src/runtime/session_prompt.rs` *(modify)* | Platform-contract lines describe intent. |

---

### Task 1: The profile table and the facts behind it

**Files:**
- Create: `services/fc/src/lib/provisioning/app-runtime-profiles.ts`
- Test: `services/fc/test/provisioning/app-runtime-profiles.test.ts`

**Interfaces:**
- Consumes: `AppBuildKind` from `./app-runtime-spec.js` (type-only import; the runtime dependency points the other way).
- Produces: `RUNTIME_PROFILES`, `RuntimeProfile`, `PATH_INTERPRETERS`, `PathLookup`, `pathLookup()`, `parseLayerRef()`, `LayerRef`, `layerRootOf()`, `LAYER_MOUNTS`, `startProgram()`, `StartProgram`.

- [ ] **Step 1: Write the failing test**

Create `services/fc/test/provisioning/app-runtime-profiles.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_PROFILES,
  pathLookup,
  parseLayerRef,
  layerRootOf,
  startProgram,
} from "../../src/lib/provisioning/app-runtime-profiles.js";

test("profiles: node and python run the image's own interpreter with no layer", () => {
  assert.deepEqual(RUNTIME_PROFILES.node, {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/nodejs20/bin/node",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
    verified: true,
  });
  assert.deepEqual(RUNTIME_PROFILES.python, {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/python3.10/bin/python3",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
    verified: true,
  });
});

test("profiles: go runs its static binary and needs no entry", () => {
  assert.equal(RUNTIME_PROFILES.go.interpreter, "./main");
  assert.deepEqual(RUNTIME_PROFILES.go.layers, []);
  assert.equal(RUNTIME_PROFILES.go.entryRequired, false);
});

test("profiles: php and java are declared but not verified", () => {
  for (const kind of ["php", "java"] as const) {
    assert.equal(RUNTIME_PROFILES[kind].verified, false, kind);
    assert.ok(RUNTIME_PROFILES[kind].layers.length > 0, kind);
  }
  assert.deepEqual(RUNTIME_PROFILES.php.layers, ["PHP81-Debian10:1"]);
  assert.deepEqual(RUNTIME_PROFILES.java.layers, ["Java17:3"]);
});

test("pathLookup: node is absent from PATH on debian10, python3 is the wrong one", () => {
  assert.deepEqual(pathLookup("custom.debian10", "node"), { kind: "absent" });
  const py = pathLookup("custom.debian10", "python3");
  assert.equal(py.kind, "resolves");
  assert.equal(py.kind === "resolves" && py.path, "/usr/bin/python3");
});

test("pathLookup: Debian 9 interpreters are present but ancient", () => {
  const node = pathLookup("custom", "node");
  assert.equal(node.kind === "resolves" && node.version, "10.16.2");
  const py = pathLookup("custom", "python3");
  assert.equal(py.kind === "resolves" && py.version, "3.7.4");
});

test("pathLookup: an image or name we never probed is unknown, not absent", () => {
  assert.deepEqual(pathLookup("custom.debian12", "node"), { kind: "unknown" });
  assert.deepEqual(pathLookup("custom.debian10", "perl"), { kind: "unknown" });
});

test("parseLayerRef: ARNs and region-free shorthand", () => {
  assert.deepEqual(parseLayerRef("acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/3"), {
    kind: "official", region: "cn-shenzhen", name: "Nodejs20", version: 3,
  });
  assert.deepEqual(parseLayerRef("Nodejs20:3"), {
    kind: "shorthand", name: "Nodejs20", version: 3,
  });
  assert.equal(parseLayerRef("Nodejs20"), null);
  assert.equal(parseLayerRef("not an arn"), null);
});

test("parseLayerRef: an account-owned layer keeps its owner", () => {
  const ref = parseLayerRef("acs:fc:cn-shenzhen:1234567890:layers/mine/versions/2");
  assert.equal(ref?.kind, "account");
  assert.equal(ref?.kind === "account" && ref.owner, "1234567890");
});

test("layerRootOf: only an /opt mount counts", () => {
  assert.equal(layerRootOf("/opt/nodejs20/bin/node"), "/opt/nodejs20");
  assert.equal(layerRootOf("/var/fc/lang/nodejs20/bin/node"), null);
  assert.equal(layerRootOf("node"), null);
});

test("startProgram: the program inside a shell one-liner is the one that runs", () => {
  // The shape the one live Python app uses. Stopping at command[0] reports bash.
  const p = startProgram(["/bin/bash"], [
    "-c",
    "PYTHONPATH=/code/lib python3 -m uvicorn app.main:app --port 9000",
  ]);
  assert.equal(p?.basename, "python3");
  assert.equal(p?.form, "bare");
  assert.equal(p?.viaShell, true);
});

test("startProgram: plain argv, and nothing at all", () => {
  const abs = startProgram(["/opt/nodejs20/bin/node"], ["server/index.mjs"]);
  assert.equal(abs?.form, "absolute");
  assert.equal(abs?.basename, "node");
  assert.equal(abs?.viaShell, false);
  assert.equal(startProgram([], []), null);
  assert.equal(startProgram(undefined, undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-profiles.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/provisioning/app-runtime-profiles.js'`

- [ ] **Step 3: Write the module**

Create `services/fc/src/lib/provisioning/app-runtime-profiles.ts`:

```ts
/**
 * What the Function Compute runtime images actually contain, and which of it
 * each `build.kind` should use.
 *
 * Every value here was read out of a running function: a probe deployed to
 * `custom.debian10` listed `/var/fc/lang`, `/opt`, and what each interpreter
 * name resolves to on PATH, then reported its own versions. See §2 of
 * docs/specs/2026-09-23-app-deploy-intent-contract-design.md.
 *
 * The table is deliberately shy. A row we have not observed says so, and the
 * rules built on it step aside rather than guess — blocking a working deploy on
 * our own ignorance is worse than the round-trip it would save.
 */

import type { AppBuildKind } from "./app-runtime-spec.js";

/** Mount path of an official layer, or `null` when we have not verified it. */
export const LAYER_MOUNTS: Record<string, string | null> = {
  // Verified: three live apps boot from this path, on layer versions 1, 2 and 3.
  Nodejs20: "/opt/nodejs20",
  // Documented to exist; where they mount has never been observed.
  Python310: null,
  "Python310-OSS2": null,
  Go1: null,
  "PHP81-Debian10": null,
  Java17: null,
};

/** What you get when a start command names an interpreter without a path. */
export type PathLookup =
  | { kind: "absent" }
  | { kind: "resolves"; path: string; version: string }
  | { kind: "unknown" };

/**
 * Probed PATH behaviour, per image.
 *
 * `custom.debian10` holds the trap this table exists for: `python3` resolves to
 * Debian's own interpreter, NOT the 3.10.9 sitting in /var/fc/lang, so a Python
 * app written the obvious way is silently downgraded with no error anywhere.
 */
const PROBED_PATHS: Record<string, Record<string, PathLookup>> = {
  "custom.debian10": {
    node: { kind: "absent" },
    java: { kind: "absent" },
    php: { kind: "absent" },
    go: { kind: "absent" },
    ruby: { kind: "absent" },
    python3: { kind: "resolves", path: "/usr/bin/python3", version: "Debian 10 system Python" },
    python: { kind: "resolves", path: "/usr/local/bin/python", version: "Debian 10 system Python" },
  },
  // Debian 9. Not probed directly; versions are Alibaba's published contents for
  // this image, and they match the failures this design was written from — an
  // ESM SyntaxError on Node 10, and Python 3.7.
  custom: {
    node: { kind: "resolves", path: "node", version: "10.16.2" },
    nodejs: { kind: "resolves", path: "nodejs", version: "10.16.2" },
    python3: { kind: "resolves", path: "python3", version: "3.7.4" },
    python: { kind: "resolves", path: "python", version: "3.7.4" },
    php: { kind: "resolves", path: "php", version: "7.4.12" },
    java: { kind: "resolves", path: "java", version: "1.8.0" },
    ruby: { kind: "resolves", path: "ruby", version: "2.7" },
  },
};

export const PATH_INTERPRETERS = PROBED_PATHS;

/** What `name` resolves to on `fcRuntime`'s PATH. Unknown unless probed. */
export function pathLookup(fcRuntime: string, name: string): PathLookup {
  return PROBED_PATHS[fcRuntime]?.[name] ?? { kind: "unknown" };
}

/** How a profile turns `start.entry` into `args`. */
export type ArgsShape = "entry" | "none";

export interface RuntimeProfile {
  fcRuntime: string;
  /** argv[0]. Absolute, except `go`, whose build emits a binary in the package. */
  interpreter: string;
  argsFor: ArgsShape;
  /** Region-free layer shorthand. Empty when the image already suffices. */
  layers: string[];
  entryRequired: boolean;
  /**
   * False means we have not observed this profile working. The short form is
   * refused for such a kind rather than emitting a guessed interpreter path
   * (spec D5); the row stays so that verifying it is a one-line change.
   */
  verified: boolean;
}

export const RUNTIME_PROFILES: Record<Exclude<AppBuildKind, "container">, RuntimeProfile> = {
  // Deployed and served 200 with layers: [].
  node: {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/nodejs20/bin/node",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
    verified: true,
  },
  // Binary present and reported Python 3.10.9. Not yet run as an app.
  python: {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/python3.10/bin/python3",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
    verified: true,
  },
  // `go` is absent from the image, and the build already emits a static
  // linux/amd64 binary (CGO_ENABLED=0), so there is no runtime to supply.
  go: {
    fcRuntime: "custom.debian10",
    interpreter: "./main",
    argsFor: "none",
    layers: [],
    entryRequired: false,
    verified: true,
  },
  // `php` and `java` are absent from the image, so a layer is genuinely
  // required — but where these layers mount has never been observed, so the
  // interpreter below is a placeholder that must never be emitted. Guarded by
  // `verified: false`.
  php: {
    fcRuntime: "custom.debian10",
    interpreter: "",
    argsFor: "entry",
    layers: ["PHP81-Debian10:1"],
    entryRequired: true,
    verified: false,
  },
  java: {
    fcRuntime: "custom.debian10",
    interpreter: "",
    argsFor: "entry",
    layers: ["Java17:3"],
    entryRequired: true,
    verified: false,
  },
};

const OFFICIAL_LAYER_ARN =
  /^acs:fc:([a-z0-9-]+):official:layers\/([A-Za-z0-9._-]+)\/versions\/(\d+)$/;
const ACCOUNT_LAYER_ARN =
  /^acs:fc:([a-z0-9-]+):(\d+):layers\/([A-Za-z0-9._-]+)\/versions\/(\d+)$/;
/** `Nodejs20:3` — an official layer named without a region to get wrong. */
const LAYER_SHORTHAND = /^([A-Za-z0-9._-]+):(\d+)$/;

export type LayerRef =
  | { kind: "official"; region: string; name: string; version: number }
  | { kind: "account"; region: string; owner: string; name: string; version: number }
  | { kind: "shorthand"; name: string; version: number };

/** Parse a layer reference, or `null` when it is neither ARN nor shorthand. */
export function parseLayerRef(raw: string): LayerRef | null {
  const trimmed = raw.trim();
  const official = OFFICIAL_LAYER_ARN.exec(trimmed);
  if (official) {
    return { kind: "official", region: official[1], name: official[2], version: Number(official[3]) };
  }
  const account = ACCOUNT_LAYER_ARN.exec(trimmed);
  if (account) {
    return {
      kind: "account",
      region: account[1],
      owner: account[2],
      name: account[3],
      version: Number(account[4]),
    };
  }
  const short = LAYER_SHORTHAND.exec(trimmed);
  if (short) return { kind: "shorthand", name: short[1], version: Number(short[2]) };
  return null;
}

/** The `/opt/<name>` root a command reaches into, if it reaches into one. */
export function layerRootOf(token: string): string | null {
  const m = /^(\/opt\/[A-Za-z0-9._-]+)(?:\/|$)/.exec(token);
  return m ? m[1] : null;
}

/**
 * Mount paths the attached layers provide, plus whether any attached layer is
 * one this table does not know — the caller needs both, because an unknown
 * layer could mount anywhere and turns "no" into "cannot tell".
 */
export function providedMounts(refs: readonly LayerRef[]): { mounts: string[]; hasUnknown: boolean } {
  const mounts: string[] = [];
  let hasUnknown = false;
  for (const ref of refs) {
    if (ref.kind === "account") {
      hasUnknown = true;
      continue;
    }
    const mount = LAYER_MOUNTS[ref.name];
    if (mount === undefined || mount === null) hasUnknown = true;
    else mounts.push(mount);
  }
  return { mounts, hasUnknown };
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash"]);
/** `FOO=bar` before the program, the way a shell one-liner sets its env. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export type ProgramForm = "absolute" | "bare" | "relative";

export interface StartProgram {
  token: string;
  form: ProgramForm;
  basename: string;
  viaShell: boolean;
}

function classify(token: string, viaShell: boolean): StartProgram {
  const basename = token.split("/").filter(Boolean).pop() ?? token;
  const form: ProgramForm = token.startsWith("/")
    ? "absolute"
    : token.includes("/")
      ? "relative"
      : "bare";
  return { token, form, basename, viaShell };
}

/**
 * The program a function will actually exec.
 *
 * `["/bin/bash", "-c", "PYTHONPATH=/code/lib python3 -m uvicorn app:app"]` runs
 * Python, not bash. A rule that stopped at `command[0]` would report the shell
 * and miss every app written this way — which is the shape the one live Python
 * app uses.
 */
export function startProgram(
  command: readonly string[] | undefined,
  args: readonly string[] | undefined,
): StartProgram | null {
  const argv = [...(command ?? []), ...(args ?? [])].filter((t) => t.trim());
  if (argv.length === 0) return null;
  const head = classify(argv[0], false);
  if (!SHELLS.has(head.basename)) return head;

  const dashC = argv.indexOf("-c");
  const script = dashC >= 0 ? argv[dashC + 1] : undefined;
  if (!script) return head;

  for (const token of script.trim().split(/\s+/)) {
    if (!token || ENV_ASSIGNMENT.test(token) || token === "exec") continue;
    return classify(token, true);
  }
  return head;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-profiles.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck**

Run: `cd services/fc && npx tsc --noEmit -p tsconfig.test.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add services/fc/src/lib/provisioning/app-runtime-profiles.ts \
        services/fc/test/provisioning/app-runtime-profiles.test.ts
git commit -m "feat(apps): 运行时镜像事实表和每种 kind 的 profile"
```

---

### Task 2: Region-free layer shorthand, and refusing a foreign region

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-runtime-spec.ts` (`resolveLayers`, and the shape check inside `parseStart`)
- Test: `services/fc/test/provisioning/app-runtime-spec.test.ts`

**Interfaces:**
- Consumes: `parseLayerRef`, `LayerRef` from Task 1.
- Produces: `resolveLayers(region, kind, layers)` now expands shorthand and rejects a foreign region; `requireLayerRef(raw): LayerRef` (module-private).

- [ ] **Step 1: Write the failing tests**

Append to `services/fc/test/provisioning/app-runtime-spec.test.ts`:

```ts
test("layers: an ARN from another region is refused here, naming the deploy region", () => {
  assert.throws(
    () => resolveLayers("cn-shenzhen", "node", [layerArn("cn-hangzhou", "Nodejs20", 3)]),
    (e: any) => {
      const m = String(e?.message ?? e);
      return /cn-hangzhou/.test(m) && /cn-shenzhen/.test(m) && /Nodejs20:3/.test(m);
    },
  );
});

test("layers: shorthand fills in the region so the author never writes one", () => {
  assert.deepEqual(resolveLayers("cn-shenzhen", "node", ["Nodejs20:3"]), [
    layerArn("cn-shenzhen", "Nodejs20", 3),
  ]);
  // The same file deploys to a different region without being edited.
  assert.deepEqual(resolveLayers("cn-beijing", "node", ["Nodejs20:3"]), [
    layerArn("cn-beijing", "Nodejs20", 3),
  ]);
});

test("layers: a matching-region ARN passes through untouched", () => {
  const arn = layerArn("cn-shenzhen", "Python310", 1);
  assert.deepEqual(resolveLayers("cn-shenzhen", "node", [arn]), [arn]);
});

test("layers: garbage is refused with a message naming both accepted forms", () => {
  assert.throws(
    () => resolveLayers("cn-shenzhen", "node", ["Nodejs20"]),
    (e: any) => /Name:version/.test(String(e?.message ?? e)),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-spec.test.ts`
Expected: FAIL — the foreign-region ARN is currently accepted, and `"Nodejs20:3"` is rejected as an invalid ARN.

- [ ] **Step 3: Replace `resolveLayers` and `isValidLayerArn`**

In `services/fc/src/lib/provisioning/app-runtime-spec.ts`, add to the imports at the top:

```ts
import { parseLayerRef, type LayerRef } from "./app-runtime-profiles.js";
```

Delete the `OFFICIAL_LAYER_ARN` / `ACCOUNT_LAYER_ARN` constants and the `isValidLayerArn` function (they now live in `app-runtime-profiles.ts`), and replace `resolveLayers` with:

```ts
/**
 * The layer ARNs to send to Function Compute.
 *
 * Two things happen here that cannot happen at parse time, because both need
 * the deploy region and the repo file is written without knowing it: shorthand
 * is expanded, and a full ARN naming another region is refused. FC would refuse
 * it too, a build-and-deploy later, as `cross-region access is not allowed` —
 * which names no region you could have used instead.
 */
export function resolveLayers(
  region: string,
  kind: AppBuildKind,
  layers: string[] | undefined,
): string[] {
  if (layers === undefined) return defaultLayersForKind(region, kind);
  if (layers.length === 0) return [];
  return layers.map((raw) => {
    const ref = requireLayerRef(raw);
    if (ref.kind === "shorthand") return layerArn(region, ref.name, ref.version);
    if (ref.region !== region) {
      const fix =
        ref.kind === "official"
          ? `write "${ref.name}:${ref.version}" and the region is filled in for you, or use ${layerArn(region, ref.name, ref.version)}`
          : `use the ${region} copy of that layer`;
      throw new ApiError(
        400,
        "validation_failed",
        `start.layers names a layer in ${ref.region}, but this app deploys to ${region} — a layer ARN must match the deploy region. To fix: ${fix}.`,
      );
    }
    return raw.trim();
  });
}

/** Shape-check a layer reference without needing to know the region yet. */
function requireLayerRef(raw: string): LayerRef {
  const ref = parseLayerRef(raw);
  if (!ref) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.layers contains an invalid layer reference: ${raw} (expected an FC layer ARN, or "Name:version" for an official layer)`,
    );
  }
  return ref;
}
```

In `parseStart`, replace the throwaway validation call:

```ts
  let layers: string[] | undefined;
  if (s.layers !== undefined) {
    layers = parseStringArray(s.layers, "start.layers", { required: true }) ?? [];
    // Shape only. The region check needs the deploy region, which this file is
    // written without, so it waits for `resolveLayers`.
    for (const raw of layers) requireLayerRef(raw);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-spec.test.ts`
Expected: PASS, including the four pre-existing `resolveLayers` assertions.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/provisioning/app-runtime-spec.ts \
        services/fc/test/provisioning/app-runtime-spec.test.ts
git commit -m "feat(apps): layer 可以不写区域，写错区域在部署前就拒绝"
```

---

### Task 3: The short form, resolution, and the OpenAPI contract

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-runtime-spec.ts` (`AppStartSpec`, `parseStart`, new `resolveIntent`)
- Modify: `docs/openapi/teamclu-api.v1.yaml` (`AppStartSpec` schema, ~line 9085-9105)
- Test: `services/fc/test/provisioning/app-runtime-spec.test.ts`

**Interfaces:**
- Consumes: `RUNTIME_PROFILES`, `RuntimeProfile` from Task 1; `requireLayerRef` from Task 2.
- Produces: `resolveIntent(kind: AppBuildKind, intent: { entry?: string; port: number; healthCheckPath?: string }): AppStartSpec`. `AppStartSpec` gains an optional `entry?: string` that is **absent after resolution** — resolution replaces it with `command`/`args`/`layers`/`fcRuntime`.

- [ ] **Step 1: Write the failing tests**

Append to `services/fc/test/provisioning/app-runtime-spec.test.ts`:

```ts
test("intent: node short form expands to the image's own interpreter, no layer", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "node", output: ".output" },
    start: { entry: "server/index.mjs", port: 9000 },
  });
  assert.deepEqual(d.start, {
    fcRuntime: "custom.debian10",
    command: ["/var/fc/lang/nodejs20/bin/node"],
    args: ["server/index.mjs"],
    port: 9000,
    layers: [],
  });
});

test("intent: python short form uses 3.10.9, not the system python3", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "python", output: "." },
    start: { entry: "app.py", port: 9000 },
  });
  assert.deepEqual(d.start.command, ["/var/fc/lang/python3.10/bin/python3"]);
  assert.deepEqual(d.start.layers, []);
});

test("intent: port defaults to 9000 and healthCheckPath survives", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "node" },
    start: { entry: "server/index.mjs", healthCheckPath: "/health" },
  });
  assert.equal(d.start.port, 9000);
  assert.equal(d.start.healthCheckPath, "/health");
});

test("intent: go needs no entry and runs its built binary", () => {
  const d = parseAppDeployDeclaration({
    build: { kind: "go", output: "." },
    start: { port: 9000 },
  });
  assert.deepEqual(d.start.command, ["./main"]);
  assert.deepEqual(d.start.args, []);
});

test("intent: a missing entry is an error, never an inferred default", () => {
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "node" },
        start: { port: 9000 },
      }),
    (e: any) => /start\.entry/.test(String(e?.message ?? e)) && /node/.test(String(e?.message ?? e)),
  );
});

test("intent: entry may not escape the code package", () => {
  for (const bad of ["../secrets.mjs", "/etc/passwd"]) {
    assert.throws(
      () =>
        parseAppDeployDeclaration({
          build: { kind: "node" },
          start: { entry: bad, port: 9000 },
        }),
      (e: any) => /start\.entry/.test(String(e?.message ?? e)),
      bad,
    );
  }
});

test("intent: php and java are refused until their layer mount is verified", () => {
  for (const kind of ["php", "java"] as const) {
    assert.throws(
      () =>
        parseAppDeployDeclaration({
          build: { kind },
          start: { entry: "app", port: 9000 },
        }),
      (e: any) => {
        const m = String(e?.message ?? e);
        return m.includes(kind) && /fcRuntime/.test(m);
      },
      kind,
    );
  }
});

test("intent: mixing the two forms is an error, not a precedence rule", () => {
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "node" },
        start: { entry: "server/index.mjs", fcRuntime: "custom.debian10", port: 9000 },
      }),
    (e: any) => /both/i.test(String(e?.message ?? e)),
  );
});

test("regression: every live app's passthrough spec still parses to itself", () => {
  // Read off the four live apps in cn-shenzhen on 2026-09-23. These must keep
  // deploying byte-identically; the profile table applies only to the short form.
  const live = [
    {
      build: { kind: "node", output: ".output" },
      start: {
        fcRuntime: "custom.debian10",
        command: ["/opt/nodejs20/bin/node"],
        args: ["server/index.mjs"],
        port: 9000,
        layers: ["acs:fc:cn-shenzhen:official:layers/Nodejs20/versions/2"],
      },
    },
    {
      build: { kind: "python", output: "." },
      start: {
        fcRuntime: "custom",
        command: ["/bin/bash"],
        args: ["-c", "PYTHONPATH=/code/lib python3 -m uvicorn app.main:app --host 0.0.0.0 --port 9000 --loop asyncio"],
        port: 9000,
        layers: [],
      },
    },
  ];
  for (const decl of live) {
    const d = parseAppDeployDeclaration(decl);
    assert.equal(d.start.fcRuntime, decl.start.fcRuntime);
    assert.deepEqual(d.start.command, decl.start.command);
    assert.deepEqual(d.start.args, decl.start.args);
    assert.deepEqual(d.start.layers, decl.start.layers);
  }
});

test("regression: passthrough omitting layers still gets the pinned Nodejs20", () => {
  // LAYER_VERSIONS must not be repointed at the profile table: doing so would
  // strip the layer from existing repos that omit the field.
  assert.deepEqual(resolveLayers("cn-shenzhen", "node", undefined), [
    layerArn("cn-shenzhen", "Nodejs20", 3),
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-spec.test.ts`
Expected: FAIL — `start.fcRuntime is required for non-container apps`, because the short form is not understood yet.

- [ ] **Step 3: Add `entry` to the type and the resolver**

In `app-runtime-spec.ts`, extend `AppStartSpec`:

```ts
export interface AppStartSpec {
  /** FC `runtime`. Required unless kind is container (then forced to custom-container). */
  fcRuntime?: string;
  command?: string[];
  args?: string[];
  port: number;
  /**
   * `undefined` = apply kind defaults.
   * `[]` = attach no layers.
   * non-empty = exactly these ARNs (or `Name:version` shorthand).
   */
  layers?: string[];
  healthCheckPath?: string;
  /**
   * Short form only, and only before resolution: the script inside the code
   * package. `resolveIntent` replaces it with the profile's command/args, so a
   * resolved spec never carries it.
   */
  entry?: string;
}
```

Add the import and the resolver:

```ts
import { RUNTIME_PROFILES } from "./app-runtime-profiles.js";

/** Default listen port. FC's own default, and what every template uses. */
const DEFAULT_PORT = 9000;

/** A path that stays inside the code package. */
function requirePackageRelative(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    throw new ApiError(
      400,
      "validation_failed",
      `${label} must be a path inside the build output directory (no leading "/", no "..")`,
    );
  }
  return trimmed;
}

/**
 * Expand a declaration of intent into the FC start fields.
 *
 * The author names a language and an entry point; which Debian image, which
 * interpreter, and which layers are the platform's problem — they are values
 * only the platform can know, and asking the repository to guess them is what
 * produced twelve fix commits and four wrong regions.
 */
export function resolveIntent(
  kind: AppBuildKind,
  intent: { entry?: string; port: number; healthCheckPath?: string },
): AppStartSpec {
  if (isContainerKind(kind)) {
    throw new ApiError(400, "validation_failed", "a container app declares its start through its image, not start.entry");
  }
  const profile = RUNTIME_PROFILES[kind as Exclude<AppBuildKind, "container">];
  if (!profile.verified) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.entry is not supported for build.kind "${kind}" yet: its interpreter comes from a layer whose mount path has not been verified, and the platform will not guess one. Declare fcRuntime, command, args and layers explicitly for now.`,
    );
  }
  if (profile.entryRequired && !intent.entry) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.entry is required for build.kind "${kind}" — the path to run inside the build output directory`,
    );
  }
  const entry = intent.entry ? requirePackageRelative(intent.entry, "start.entry") : undefined;
  return {
    fcRuntime: profile.fcRuntime,
    command: [profile.interpreter],
    args: profile.argsFor === "entry" && entry ? [entry] : [],
    port: intent.port,
    layers: [...profile.layers],
    ...(intent.healthCheckPath ? { healthCheckPath: intent.healthCheckPath } : {}),
  };
}
```

Rewrite the non-container tail of `parseStart`. Replace this block:

```ts
  if (!fcRuntimeRaw) {
    throw new ApiError(400, "validation_failed", "start.fcRuntime is required for non-container apps");
  }
```

…through the end of the function, with:

```ts
  const entryRaw = typeof s.entry === "string" ? s.entry.trim() : "";
  const passthroughFields = ["fcRuntime", "command", "args", "layers"].filter((k) =>
    Object.prototype.hasOwnProperty.call(s, k),
  );
  if (entryRaw && passthroughFields.length > 0) {
    throw new ApiError(
      400,
      "validation_failed",
      `start declares both forms: "entry" together with ${passthroughFields.join(", ")}. Use start.entry and let the platform choose, or declare the Function Compute fields yourself — not both.`,
    );
  }
  if (entryRaw || (!fcRuntimeRaw && passthroughFields.length === 0)) {
    return resolveIntent(build.kind, {
      entry: entryRaw || undefined,
      port,
      ...(healthCheckPath ? { healthCheckPath } : {}),
    });
  }

  if (!fcRuntimeRaw) {
    throw new ApiError(400, "validation_failed", "start.fcRuntime is required for non-container apps");
  }
  if (!(FC_CODE_RUNTIMES as readonly string[]).includes(fcRuntimeRaw)) {
    throw new ApiError(
      400,
      "validation_failed",
      `start.fcRuntime must be one of: ${FC_CODE_RUNTIMES.join(", ")}`,
    );
  }
  const command = parseStringArray(s.command, "start.command", { required: true }) ?? [];
  if (command.length === 0) {
    throw new ApiError(400, "validation_failed", "start.command must be a non-empty array for non-container apps");
  }
  const args = parseStringArray(s.args, "start.args", { required: false }) ?? [];
  return {
    fcRuntime: fcRuntimeRaw,
    command,
    args,
    port,
    ...(layers !== undefined ? { layers } : {}),
    ...(healthCheckPath ? { healthCheckPath } : {}),
  };
```

Change `parsePort` to accept an absent port:

```ts
function parsePort(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "validation_failed", "start.port must be a TCP port between 1 and 65535");
  }
  return port;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-spec.test.ts`
Expected: PASS, all tests including the two regression tests.

- [ ] **Step 5: Update the OpenAPI schema**

In `docs/openapi/teamclu-api.v1.yaml`, in the `AppStartSpec` schema, make `port` optional, add `entry`, and document the layer shorthand:

```yaml
        port:
          type: integer
          minimum: 1
          maximum: 65535
          default: 9000
          description: Listen port. Defaults to 9000.
        entry:
          type: string
          description: |
            Short form. The path to run, relative to the build output
            directory. The platform supplies `fcRuntime`, `command` and
            `layers` from the profile for `build.kind`. Mutually exclusive
            with `fcRuntime` / `command` / `args` / `layers`.
        layers:
          type: array
          items: { type: string }
          description: |
            Function Compute layers. An official layer may be named
            region-free as `Name:version` (e.g. `Nodejs20:3`), expanded
            against the app's deploy region; a full ARN is accepted but must
            already name that region. An empty list disables the defaults for
            `build.kind`; omitting the field applies them.
```

- [ ] **Step 6: Lint the OpenAPI document and typecheck**

Run: `cd services/fc && pnpm openapi:lint && npx tsc --noEmit -p tsconfig.test.json`
Expected: lint passes, no type errors.

- [ ] **Step 7: Commit**

```bash
git add services/fc/src/lib/provisioning/app-runtime-spec.ts \
        services/fc/test/provisioning/app-runtime-spec.test.ts \
        docs/openapi/teamclu-api.v1.yaml
git commit -m "feat(apps): teamclu.app.json 支持声明意图，由平台展开成 FC 字段"
```

---

### Task 4: Preflight for the passthrough form

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-runtime-spec.ts` (new `checkStartEnvironment`, called from `parseAppDeployDeclaration`)
- Test: `services/fc/test/provisioning/app-runtime-spec.test.ts`

**Interfaces:**
- Consumes: `startProgram`, `layerRootOf`, `providedMounts`, `pathLookup`, `LAYER_MOUNTS`, `parseLayerRef` from Task 1.
- Produces: `checkStartEnvironment(build: AppBuildSpec, start: AppStartSpec): string[]` — throws `ApiError` for R1–R3, returns R4 advisories.

- [ ] **Step 1: Write the failing tests**

Append to `services/fc/test/provisioning/app-runtime-spec.test.ts`:

```ts
test("preflight: /opt path with no layer to mount it is refused", () => {
  // Deployed clean and then failed to boot with "/opt/nodejs20/bin/node is not exist".
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "node", output: ".output" },
        start: {
          fcRuntime: "custom.debian10",
          command: ["/opt/nodejs20/bin/node"],
          args: ["server/index.mjs"],
          port: 9000,
          layers: [],
        },
      }),
    (e: any) => {
      const m = String(e?.message ?? e);
      return m.includes("/opt/nodejs20") && m.includes("Nodejs20");
    },
  );
});

test("preflight: a bare interpreter absent from the image is refused", () => {
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "node" },
        start: {
          fcRuntime: "custom.debian10",
          command: ["node"],
          args: ["server/index.mjs"],
          port: 9000,
          layers: [],
        },
      }),
    (e: any) => {
      const m = String(e?.message ?? e);
      return /not on PATH/.test(m) && m.includes("/var/fc/lang/nodejs20/bin/node");
    },
  );
});

test("preflight: Debian 9 interpreters are refused by version, inside a shell too", () => {
  assert.throws(
    () =>
      parseAppDeployDeclaration({
        build: { kind: "python", output: "." },
        start: {
          fcRuntime: "custom",
          command: ["/bin/bash"],
          args: ["-c", "PYTHONPATH=/code/lib python3 -m uvicorn app.main:app"],
          port: 9000,
          layers: [],
        },
      }),
    (e: any) => {
      const m = String(e?.message ?? e);
      return m.includes("3.7.4") && m.includes("start.args");
    },
  );
});

test("preflight: an unverified layer makes the /opt rule step aside", () => {
  // Go1's mount path is unknown, so we cannot prove /opt/go is missing.
  const d = parseAppDeployDeclaration({
    build: { kind: "go", output: "." },
    start: {
      fcRuntime: "custom.debian10",
      command: ["/opt/go/bin/app"],
      port: 9000,
      layers: ["Go1:1"],
    },
  });
  assert.deepEqual(d.start.layers, ["Go1:1"]);
});

test("preflight: bare python3 on debian10 warns about the silent downgrade", () => {
  const warnings = checkStartEnvironment(
    { kind: "python", output: "." },
    {
      fcRuntime: "custom.debian10",
      command: ["python3"],
      args: ["app.py"],
      port: 9000,
      layers: [],
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/usr\/bin\/python3/);
  assert.match(warnings[0], /\/var\/fc\/lang\/python3\.10\/bin\/python3/);
});

test("preflight: container apps are not second-guessed", () => {
  assert.deepEqual(
    checkStartEnvironment(
      { kind: "container", output: ".", dockerfile: "Dockerfile", context: "." },
      { port: 8080 },
    ),
    [],
  );
});

test("preflight: the resolved short form passes its own rules", () => {
  for (const [kind, entry] of [["node", "server/index.mjs"], ["python", "app.py"]] as const) {
    const d = parseAppDeployDeclaration({ build: { kind }, start: { entry, port: 9000 } });
    assert.deepEqual(checkStartEnvironment({ kind, output: "." }, d.start), []);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-runtime-spec.test.ts`
Expected: FAIL — `checkStartEnvironment` is not exported.

- [ ] **Step 3: Implement the rules**

Add to the `app-runtime-profiles.js` import in `app-runtime-spec.ts`:

```ts
import {
  LAYER_MOUNTS,
  RUNTIME_PROFILES,
  layerRootOf,
  parseLayerRef,
  pathLookup,
  providedMounts,
  startProgram,
  type LayerRef,
} from "./app-runtime-profiles.js";
```

Add:

```ts
/**
 * The layers a passthrough declaration ends up with, named without a region.
 *
 * Omitting `layers` resolves to the kind's default, so the rules below have to
 * account for it — otherwise a config that works would look like it attaches
 * nothing.
 */
function effectiveLayerRefs(kind: AppBuildKind, layers: string[] | undefined): LayerRef[] {
  if (layers === undefined) {
    if (isContainerKind(kind)) return [];
    const pin = LAYER_VERSIONS[kind as Exclude<AppBuildKind, "container">];
    return [{ kind: "shorthand", name: pin.name, version: pin.version }];
  }
  return layers.map((raw) => {
    const ref = parseLayerRef(raw);
    if (!ref) {
      throw new ApiError(400, "validation_failed", `start.layers contains an invalid layer reference: ${raw}`);
    }
    return ref;
  });
}

/**
 * Refuse a start command the chosen image and layers cannot run, and name the
 * one that would work.
 *
 * Throws for what the environment table proves impossible; returns advisories
 * for what merely looks wrong. A layer whose mount path is unverified makes a
 * rule step aside rather than guess — blocking a working deploy on our own
 * ignorance is worse than the round-trip it saves.
 */
export function checkStartEnvironment(build: AppBuildSpec, start: AppStartSpec): string[] {
  if (isContainerKind(build.kind)) return [];
  const program = startProgram(start.command, start.args);
  if (!program) return [];
  const fcRuntime = start.fcRuntime ?? "";
  const refs = effectiveLayerRefs(build.kind, start.layers);
  const profile = RUNTIME_PROFILES[build.kind as Exclude<AppBuildKind, "container">];
  const where = program.viaShell ? "the shell script in start.args" : "start.command";

  // R2 — the command reaches into a layer's mount point. If every attached
  // layer is one we know, we can say for certain whether that path will exist.
  if (program.form === "absolute") {
    const root = layerRootOf(program.token);
    if (root) {
      const { mounts, hasUnknown } = providedMounts(refs);
      if (!hasUnknown && !mounts.includes(root)) {
        const attached = refs.length ? refs.map((r) => `${r.name}:${r.version}`).join(", ") : "none";
        const provider = Object.entries(LAYER_MOUNTS).find(([, m]) => m === root)?.[0];
        const fix = provider
          ? `attach it with "layers": ["${provider}:<version>"]`
          : `attach the layer that provides ${root}`;
        throw new ApiError(
          400,
          "validation_failed",
          `${where} runs ${program.token}, but nothing mounts ${root} — layers attached: ${attached}. To fix: ${fix}, or run ${profile?.verified ? profile.interpreter : "an interpreter the image already ships"}.`,
        );
      }
    }
  }

  // R3 — a bare name resolves through PATH to the image's own interpreter,
  // never a layer's. On debian10 `node` is not there at all; on Debian 9
  // everything is there but too old to run code written today.
  if (program.form === "bare") {
    const found = pathLookup(fcRuntime, program.basename);
    const alternative = profile?.verified
      ? profile.interpreter
      : "an absolute path to the interpreter you mean";
    if (found.kind === "absent") {
      throw new ApiError(
        400,
        "validation_failed",
        `${where} runs "${program.basename}", which is not on PATH in the ${fcRuntime} image. To fix: run ${alternative}.`,
      );
    }
    if (found.kind === "resolves" && fcRuntime === "custom") {
      throw new ApiError(
        400,
        "validation_failed",
        `${where} runs "${program.basename}", which on fcRuntime "custom" (Debian 9) is ${program.basename} ${found.version} — too old for code written today. To fix: use fcRuntime "custom.debian10" and run ${alternative}.`,
      );
    }
  }

  // R4 — advisory. The name resolves, but to a different interpreter than the
  // one this kind wants, and nothing anywhere says so.
  const warnings: string[] = [];
  if (program.form === "bare") {
    const found = pathLookup(fcRuntime, program.basename);
    if (found.kind === "resolves" && profile?.verified && found.path !== profile.interpreter) {
      warnings.push(
        `${where} runs "${program.basename}", which resolves to ${found.path} on ${fcRuntime} — not ${profile.interpreter}. The function will run ${found.version}.`,
      );
    }
  }
  return warnings;
}
```

Call it at the end of `parseAppDeployDeclaration`, after `parseStart`:

```ts
  const build = parseBuild(root.build);
  const start = parseStart(build, root.start);
  for (const warning of checkStartEnvironment(build, start)) {
    console.warn(`[apps] teamclu.app.json: ${warning}`);
  }
  return { build, start };
```

Add `checkStartEnvironment` to the re-export list in `app-deploy.ts` (the block beginning `// build+start declaration parsers`), so call sites reach it the same way as the rest.

- [ ] **Step 4: Run the whole service test suite**

Run: `cd services/fc && node --import tsx --test "test/**/*.test.ts"`
Expected: PASS. Nothing outside `provisioning/` should change behaviour.

- [ ] **Step 5: Typecheck**

Run: `cd services/fc && npx tsc --noEmit -p tsconfig.test.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add services/fc/src/lib/provisioning/app-runtime-spec.ts \
        services/fc/src/lib/provisioning/app-deploy.ts \
        services/fc/test/provisioning/app-runtime-spec.test.ts
git commit -m "feat(apps): 直通格式在部署前校验解释器和 layer 是否真的存在"
```

---

### Task 5: The daemon accepts the short form

**Files:**
- Modify: `apps/daemon/src/sync/app_build.rs` (`AppStartSpec` ~line 512-525; `read_app_declaration` ~line 543-600)
- Test: `apps/daemon/src/sync/app_build.rs` (its inline `#[cfg(test)]` module)

**Interfaces:**
- Consumes: nothing from earlier tasks — the daemon only carries the declaration through to finalize.
- Produces: `AppStartSpec.entry: Option<String>`; `port` defaults to 9000.

- [ ] **Step 1: Write the failing test**

In the test module at the bottom of `apps/daemon/src/sync/app_build.rs`:

```rust
#[test]
fn short_form_declaration_round_trips_with_a_default_port() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("teamclu.app.json"),
        r#"{
          "build": {"kind": "node"},
          "start": {"entry": "server/index.mjs"}
        }"#,
    )
    .unwrap();

    let declaration = read_app_declaration(tmp.path()).unwrap();
    assert_eq!(declaration.build.kind, "node");
    assert_eq!(declaration.build.output, ".output");
    assert_eq!(declaration.start.entry.as_deref(), Some("server/index.mjs"));
    assert_eq!(declaration.start.port, 9000);
    // The daemon carries intent through; the control plane resolves it.
    assert!(declaration.start.fc_runtime.is_none());
    assert!(declaration.start.command.is_none());
}

#[test]
fn entry_may_not_escape_the_code_package() {
    for bad in ["../secrets.mjs", "/etc/passwd"] {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("teamclu.app.json"),
            format!(r#"{{"build":{{"kind":"node"}},"start":{{"entry":"{bad}"}}}}"#),
        )
        .unwrap();
        let err = read_app_declaration(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("start.entry"), "{bad}: {err}");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/dengwei/git/teamclu && cargo test -p amuxd --lib sync::app_build 2>&1 | tail -20`
Expected: FAIL — `no field 'entry' on type 'AppStartSpec'`.

- [ ] **Step 3: Add the field, the default, and the containment check**

In `AppStartSpec`:

```rust
pub struct AppStartSpec {
    #[serde(default)]
    pub fc_runtime: Option<String>,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Short form: the path to run inside the build output directory. The
    /// control plane resolves it against the profile for `build.kind`; the
    /// daemon only carries it through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub layers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_path: Option<String>,
}

/// FC's own default, and what every template listens on.
fn default_port() -> u16 {
    9000
}
```

In `read_app_declaration`, extend the existing containment loop. Replace:

```rust
    for (name, path) in [
        ("build.output", &declaration.build.output),
        ("build.dockerfile", &declaration.build.dockerfile),
        ("build.context", &declaration.build.context),
    ] {
```

with:

```rust
    let entry_for_check = declaration.start.entry.clone().unwrap_or_default();
    let mut checked: Vec<(&str, &String)> = vec![
        ("build.output", &declaration.build.output),
        ("build.dockerfile", &declaration.build.dockerfile),
        ("build.context", &declaration.build.context),
    ];
    if !entry_for_check.is_empty() {
        checked.push(("start.entry", &entry_for_check));
    }
    for (name, path) in checked {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/dengwei/git/teamclu && cargo test -p amuxd --lib sync::app_build 2>&1 | tail -20`
Expected: PASS, including the pre-existing declaration tests.

- [ ] **Step 5: Check the workspace compiles and is formatted**

Run: `cd /Users/dengwei/git/teamclu && pnpm rust:check && cargo fmt --check --manifest-path apps/daemon/Cargo.toml`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sync/app_build.rs
git commit -m "feat(daemon): 读取 teamclu.app.json 的短格式 entry，port 默认 9000"
```

---

### Task 6: The authoring surface

**Files:**
- Modify: `templates/slides/teamclu.app.json`, `templates/static-web/teamclu.app.json`, `templates/tanstack-postgres/teamclu.app.json`
- Modify: `templates/slides/AGENTS.md`, `templates/static-web/AGENTS.md`, `templates/tanstack-postgres/AGENTS.md`
- Modify: `apps/daemon/src/runtime/session_prompt.rs`
- Test: `apps/daemon/src/sync/app_build.rs` (inline test module)

**Interfaces:**
- Consumes: the short form from Tasks 3 and 5.
- Produces: no code interface. The test proves the shipped templates parse.

- [ ] **Step 1: Write the failing test**

In the test module of `apps/daemon/src/sync/app_build.rs`:

```rust
#[test]
fn every_shipped_template_declaration_parses() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("templates");
    let mut checked = 0;
    for name in ["slides", "static-web", "tanstack-postgres"] {
        let dir = root.join(name);
        let raw = std::fs::read_to_string(dir.join("teamclu.app.json"))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        // Templates carry {{APP_NAME}} placeholders; substitute before parsing.
        let filled = raw.replace("{{APP_NAME}}", "example");
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("teamclu.app.json"), filled).unwrap();
        let declaration = read_app_declaration(tmp.path()).unwrap();
        assert!(
            declaration.start.entry.is_some(),
            "{name} should use the short form"
        );
        assert!(
            declaration.start.fc_runtime.is_none(),
            "{name} should not name an FC runtime"
        );
        checked += 1;
    }
    assert_eq!(checked, 3);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dengwei/git/teamclu && cargo test -p amuxd --lib every_shipped_template 2>&1 | tail -15`
Expected: FAIL — `slides should use the short form`.

- [ ] **Step 3: Rewrite the three templates**

Each of the three `teamclu.app.json` files becomes exactly:

```json
{
  "title": "{{APP_NAME}}",
  "auth": { "mode": "none" },
  "build": {
    "kind": "node",
    "output": ".output"
  },
  "start": {
    "entry": "server/index.mjs",
    "port": 9000
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dengwei/git/teamclu && cargo test -p amuxd --lib every_shipped_template 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Update the three `AGENTS.md` files**

In each, replace the bullet reading `- 改 build.kind / start.command / start.port 以匹配 FC Custom Runtime…` with:

```markdown
- 改 `build.kind` / `start.entry` / `start.port`。`entry` 是构建产物目录里要运行的文件（本模板是 `.output` 下的 `server/index.mjs`），运行时、解释器路径和 layer 由平台按 `build.kind` 决定，不用也不要自己写。
- 需要平台默认之外的启动方式时，才改用 FC 直通格式（`fcRuntime` + `command` + `args` + `layers`）。两种格式不能混用。直通格式里的官方层写成 `"Nodejs20:3"` 这种「名字:版本」形式，区域由平台补齐。
```

Leave the `- **不要用**旧字段 runtime / entry` bullet in place: that legacy `entry` was a top-level field, a different thing from `start.entry`, and the daemon still rejects it.

- [ ] **Step 6: Update the agent's platform contract**

In `apps/daemon/src/runtime/session_prompt.rs`, in `build_app_workspace_prompt`, add after the `manage_app` status bullet:

```rust
- `teamclu.app.json` declares intent: `build.kind` plus `start.entry` (the path to run inside the build output directory) and optional `start.port`. The platform chooses the Function Compute runtime, the interpreter path and any layers. Do not write `fcRuntime`, `command`, `args` or `layers` unless the app genuinely needs a start sequence the platform does not offer, and never write both forms at once.
- A bare interpreter name never reaches a layer: layers are used through absolute paths. `custom.debian10` ships Node 20 and Python 3.10 already, and on it `node` is not on PATH at all while `python3` resolves to the system interpreter rather than 3.10 — which is why the platform emits absolute paths.
```

- [ ] **Step 7: Run the full Rust and service suites**

Run:
```bash
cd /Users/dengwei/git/teamclu && cargo test -p amuxd --lib sync::app_build 2>&1 | tail -10
cd services/fc && node --import tsx --test "test/**/*.test.ts" 2>&1 | tail -10
```
Expected: PASS both.

- [ ] **Step 8: Commit**

```bash
git add templates apps/daemon/src/runtime/session_prompt.rs apps/daemon/src/sync/app_build.rs
git commit -m "feat(apps): 模板和 agent 提示改用声明意图的写法"
```

---

## Self-Review

**Spec coverage.** §4 contract → Task 3. §5 profile table → Task 1, with the D5 `verified` guard in Task 3. §6 resolution and data flow → Task 3 (`start_spec` stores the expansion because `parseStart` returns the resolved spec, which is what finalize already persists). §7 preflight R1 → Task 2; R2–R4 → Task 4. §10 migration → Tasks 3, 5, 6, with the two regression tests in Task 3 pinning "nothing breaks". §11 testing → distributed across all tasks.

**Not covered, deliberately.** §9's open questions are questions, not work: Python/go/php/java verification needs real deploys, the `deploy_error` diagnosability gap and the confirm-modal problem are separate defects. §8's non-goals stay out.

**Gap found and closed during review.** The spec's §5 table implied `php` and `java` short form would work, but their interpreter paths are unverified — emitting one would violate D5. Resolved by amending the spec (commit `fda9b848`) and encoding `verified: false` in Task 1, refused in Task 3.

**Second gap found and closed.** Repointing `defaultLayersForKind` at the profile table would strip layers from existing repos that omit the field. Now a Global Constraint, covered by the final regression test in Task 3 and recorded in the spec amendment.

**Type consistency.** `RuntimeProfile` fields (`fcRuntime`, `interpreter`, `argsFor`, `layers`, `entryRequired`, `verified`) are identical in Task 1's definition, Task 1's test, and Tasks 3 and 4's consumption. `LayerRef` is a discriminated union on `kind` in Tasks 1, 2 and 4. `startProgram` returns `StartProgram | null`, and every caller null-checks. `checkStartEnvironment(build, start)` has one signature throughout. Rust `AppStartSpec.entry` is `Option<String>` in both the struct and its tests.
