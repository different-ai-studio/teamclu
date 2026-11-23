"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Drop a Windows verbatim prefix before a path reaches Node's realpath.
 *
 * `\\?\D:\...` is what Rust `canonicalize` returns. Node 22+ walks that form
 * by calling `lstat('D:')`, which throws
 * `EISDIR: illegal operation on a directory`. The plain path is the same file.
 * POSIX paths and `documents/...` prefixes are returned unchanged.
 */
function plainPathForNode(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  const unc = /^(?:\\\\[?]\\UNC\\|\/\/[?]\/UNC\/)/i.exec(input);
  if (unc) {
    const sep = input.includes("/") ? "/" : "\\";
    return `${sep}${sep}${input.slice(unc[0].length)}`;
  }
  const verbatim = /^(?:\\\\[?]\\|\/\/[?]\/)/.exec(input);
  if (verbatim) {
    const rest = input.slice(verbatim[0].length);
    if (/^[A-Za-z]:[\\/]/.test(rest)) return rest;
    if (/^[A-Za-z]:$/.test(rest)) return `${rest}\\`;
    return input;
  }
  return input;
}

function pathApi(root) {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") || root.startsWith("//")
    ? path.win32
    : path;
}

/** Absolute file under a documents root. `documents/AI行业应用/a.pdf` stays a relative suffix. */
function documentsFilePath(documentsRoot, documentsPath) {
  const root = plainPathForNode(documentsRoot);
  const relative = String(documentsPath || "").replace(/^documents\//, "");
  return pathApi(root).join(root, relative);
}

/**
 * realpath that never asks Node to lstat a bare drive letter.
 * A drive root (`D:` or `D:\`) is already canonical.
 */
function safeRealpathSync(target, fsImpl = fs) {
  const plain = plainPathForNode(target);
  if (/^[A-Za-z]:[\\/]?$/.test(plain)) {
    return `${plain[0]}:\\`;
  }
  const realpath =
    typeof fsImpl.realpathSync?.native === "function"
      ? fsImpl.realpathSync.native
      : fsImpl.realpathSync;
  return realpath(plain);
}

module.exports = {
  plainPathForNode,
  documentsFilePath,
  safeRealpathSync,
};
