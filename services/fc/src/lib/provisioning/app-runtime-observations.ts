import type { AppLanguage } from "./app-runtime-catalog.js";
/** Historical evidence recorded in the 2026-09-23 design, not current provider discovery. */
export interface RuntimeObservation {
  runtime: string;
  language: AppLanguage;
  kind: "interpreter" | "pathLookup" | "layerMount";
  path?: string;
  version?: string;
  name?: string;
  layerVersions?: number[];
  lookup?: PathLookup;
  region: string | null;
  /** Date of the historical record, not necessarily the probe execution. */
  recordedAt: string;
  probeDate: string | null;
  verificationStatus: "historicalProbe";
  provenance: string;
}
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
export const PROBED_PATHS: Record<string, Record<string, PathLookup>> = {
  "custom.debian10": {
    node: { kind: "absent" },
    java: { kind: "absent" },
    php: { kind: "absent" },
    go: { kind: "absent" },
    ruby: { kind: "absent" },
    python3: { kind: "resolves", path: "/usr/bin/python3", version: "Debian 10 system Python" },
    python: { kind: "resolves", path: "/usr/local/bin/python", version: "Debian 10 system Python" },
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


export function readRuntimeObservations(language?: AppLanguage): RuntimeObservation[] {
  const common = { runtime: "custom.debian10", region: null, recordedAt: "2026-09-23", probeDate: null, verificationStatus: "historicalProbe" as const,
    provenance: "docs/specs/2026-09-23-app-deploy-intent-contract-design.md#21-what-the-runtime-image-contains (probe log; exact timestamp and region not retained)" };
  const observations: RuntimeObservation[] = Object.entries(IMAGE_INTERPRETERS["custom.debian10"]).map(([name, value]) =>
    ({ ...common, kind: "interpreter", language: name.startsWith("node") ? "node" : "python", name, ...value }));
  for (const [name, lookup] of Object.entries(PROBED_PATHS["custom.debian10"])) {
    const family = name.startsWith("python") ? "python" : name;
    if (!["node", "python", "go", "php", "java"].includes(family)) continue;
    observations.push({ ...common, kind: "pathLookup", language: family as AppLanguage, name, lookup });
  }
  observations.push({ ...common, kind: "layerMount", language: "node", name: "Nodejs20", path: "/opt/nodejs20", layerVersions: [1, 2, 3] });
  return structuredClone(observations.filter(o => !language || o.language === language));
}
