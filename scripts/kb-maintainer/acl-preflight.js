"use strict";

const { prefixesOverlap } = require("./paths");

function restrictedDocumentPrefixes(aclPrefixes) {
  if (!Array.isArray(aclPrefixes)) {
    throw new Error("ACL state unknown; cannot confirm which documents are restricted");
  }
  const prefixes = aclPrefixes.filter(
    (prefix) => typeof prefix === "string" && prefix.startsWith("documents/"),
  );
  return [...new Set(prefixes)].sort();
}

function isRestrictedPath(documentsPath, restrictedPrefixes) {
  return restrictedPrefixes.some((prefix) => {
    if (documentsPath === prefix) return true;
    const folder = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return documentsPath.startsWith(folder);
  });
}

function restrictedSourceFolders(sourcePrefixes, restrictedPrefixes) {
  return restrictedPrefixes.filter((restricted) =>
    sourcePrefixes.some((source) => prefixesOverlap(source, restricted)),
  );
}

module.exports = { isRestrictedPath, restrictedDocumentPrefixes, restrictedSourceFolders };
