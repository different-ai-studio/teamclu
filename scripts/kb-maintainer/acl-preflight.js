"use strict";

const { prefixesOverlap } = require("./paths");

function assertDocumentsAclAllowsPublish({ whitelistPrefixes, aclPrefixes }) {
  if (!Array.isArray(aclPrefixes)) {
    throw new Error("ACL state unknown; cannot confirm documents prefixes are team-public");
  }
  const documentAcls = aclPrefixes.filter((prefix) => typeof prefix === "string" && prefix.startsWith("documents/"));
  const conflicts = [];
  for (const allowed of whitelistPrefixes) {
    for (const restricted of documentAcls) {
      if (prefixesOverlap(allowed, restricted)) {
        conflicts.push({ whitelist: allowed, acl: restricted });
      }
    }
  }
  if (conflicts.length > 0) {
    const detail = conflicts.map((item) => `${item.whitelist} ∩ ${item.acl}`).join("; ");
    throw new Error(`whitelist intersects restricted documents ACL: ${detail}`);
  }
}

module.exports = { assertDocumentsAclAllowsPublish };
