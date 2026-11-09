#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { assertMacosReleaseBundles, repoRoot } = require("./lib/wiki-maintainer-bundle");

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const app = argValue(args, "--app");
  try {
    const checked = assertMacosReleaseBundles({
      repoRoot,
      target: argValue(args, "--target"),
      debug: args.includes("--debug"),
      cargoTargetDir: process.env.CARGO_TARGET_DIR,
      apps: app ? [path.resolve(app)] : undefined,
    });
    for (const bundle of checked) {
      console.log(`Wiki maintenance resources are present in ${bundle}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
