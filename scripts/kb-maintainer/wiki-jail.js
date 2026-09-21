"use strict";

const fs = require("node:fs");
const path = require("node:path");

function assertWikiPath(workRoot, input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Wiki path is empty");
  }
  const wikiRoot = fs.realpathSync(path.join(workRoot, "wiki"));
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(wikiRoot, input);
  let canonical = resolved;
  try {
    canonical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.resolve(resolved);
  } catch {
    canonical = path.resolve(resolved);
  }
  const prefix = wikiRoot.endsWith(path.sep) ? wikiRoot : `${wikiRoot}${path.sep}`;
  if (canonical !== wikiRoot && !canonical.startsWith(prefix)) {
    throw new Error(`path escapes wiki/: ${input}`);
  }
  return canonical;
}

function jailedWikiOperations(workRoot) {
  const fsP = fs.promises;
  return {
    async writeFile(absolutePath, content) {
      const resolved = assertWikiPath(workRoot, absolutePath);
      await fsP.mkdir(path.dirname(resolved), { recursive: true });
      await fsP.writeFile(resolved, content);
    },
    async mkdir(dir) {
      await fsP.mkdir(assertWikiPath(workRoot, dir), { recursive: true });
    },
    async readFile(absolutePath) {
      return fsP.readFile(assertWikiPath(workRoot, absolutePath));
    },
    async access(absolutePath) {
      await fsP.access(assertWikiPath(workRoot, absolutePath));
    },
    async exists(absolutePath) {
      try {
        await fsP.access(assertWikiPath(workRoot, absolutePath));
        return true;
      } catch {
        return false;
      }
    },
    glob(pattern, cwd) {
      const rooted = assertWikiPath(workRoot, cwd || path.join(workRoot, "wiki"));
      const results = [];
      const match = globToRegExp(pattern);
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const abs = path.join(dir, name);
          if (fs.statSync(abs).isDirectory()) {
            walk(abs);
            continue;
          }
          const rel = path.relative(rooted, abs).split(path.sep).join("/");
          if (match.test(rel) || match.test(name)) results.push(rel);
        }
      };
      walk(rooted);
      return results;
    },
  };
}

function globToRegExp(pattern) {
  const escaped = String(pattern || "*")
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::DOTSTAR:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::DOTSTAR:::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

module.exports = { assertWikiPath, jailedWikiOperations };
