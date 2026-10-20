/** Legacy preflight helpers. Probed evidence lives in app-runtime-observations. */
import { LAYER_MOUNTS, readRuntimeObservations, PROBED_PATHS, IMAGE_INTERPRETERS, IMAGE_DEBIAN, type Interpreter } from "./app-runtime-observations.js";
export { pathLookup, interpreterFor, PATH_INTERPRETERS, IMAGE_INTERPRETERS, IMAGE_DEBIAN, LAYER_MOUNTS } from "./app-runtime-observations.js";
export type { Interpreter, PathLookup } from "./app-runtime-observations.js";

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
    const mount = readRuntimeObservations().find(o => o.kind === "layerMount" && o.name === ref.name && o.layerVersions?.includes(ref.version))?.path;
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
