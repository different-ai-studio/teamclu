"use strict";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += escapeRegex(pattern[i]);
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

function globMatch(pattern, value) {
  return globToRegExp(pattern).test(value);
}

module.exports = { globToRegExp, globMatch };
