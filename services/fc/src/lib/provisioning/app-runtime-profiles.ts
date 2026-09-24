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

/** Debian version per image, for messages and facts that need to name it. */
export const IMAGE_DEBIAN: Record<string, string> = {
  "custom.debian10": "10.13",
  custom: "9",
};

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
}

/**
 * Kinds whose start really is `<interpreter> <entry>`.
 *
 * Python is deliberately absent: its real shape is
 * `python3 -m uvicorn app.main:app` with an import path the app's own build
 * decides, which no table can own — the one live Python app here proves it.
 * PHP and Java are absent because their interpreter lives in a layer whose
 * mount path has never been observed. Those kinds use the passthrough form,
 * which is the normal road and not a penalty.
 */
export const SHORT_FORM_PROFILES: Record<string, RuntimeProfile> = {
  // Deployed and served 200 with layers: [].
  node: {
    fcRuntime: "custom.debian10",
    interpreter: "/var/fc/lang/nodejs20/bin/node",
    argsFor: "entry",
    layers: [],
    entryRequired: true,
  },
  // `go` is absent from the image, and the build already emits a static
  // linux/amd64 binary (CGO_ENABLED=0), so there is no runtime to supply.
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
    return {
      kind: "official",
      region: official[1],
      name: official[2],
      version: Number(official[3]),
    };
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
export function providedMounts(refs: readonly LayerRef[]): {
  mounts: string[];
  hasUnknown: boolean;
} {
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
 * This exists because none of it was reachable from inside a repository. The
 * region lived in the server's environment, the image contents were undocumented
 * anywhere the agent could see, and the result was twelve fix commits guessing
 * at both.
 *
 * Hand-verified constants, not live introspection — so a preflight failing on
 * something stated here is the signal to re-probe the image, not to work around
 * the message.
 */
export function runtimeFacts(region: string): RuntimeFacts {
  const images: RuntimeFacts["images"] = {};
  for (const fcRuntime of Object.keys(IMAGE_DEBIAN)) {
    const onPath: RuntimeFacts["images"][string]["onPath"] = {};
    for (const [name, lookup] of Object.entries(PROBED_PATHS[fcRuntime] ?? {})) {
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
      'fcRuntime "custom" is Debian 9: Node 10.16.2 and Python 3.7.4, too old for most current packages.',
      "Layers mount under /opt; the image's own interpreters live under /var/fc/lang.",
      'A layer ARN is region-scoped. Write "Name:version" and the platform fills in the region.',
    ],
  };
}
