"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEMPLATE_PATH = path.join(__dirname, "templates", "_schema.md");

/**
 * Write the default `_schema.md` into the knowledge root when it has none.
 *
 * Never overwrites: an existing file — even an empty one — is the team's own
 * decision, and the dry-run check reports it. A missing knowledge root is left
 * missing, because the daemon owns that directory and creating it here would
 * shadow the workspace link.
 */
function seedSchema(knowledgeRoot) {
  if (!knowledgeRoot) return false;
  let stat;
  try {
    stat = fs.statSync(knowledgeRoot);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  try {
    fs.writeFileSync(path.join(knowledgeRoot, "_schema.md"), fs.readFileSync(TEMPLATE_PATH), {
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    throw error;
  }
}

module.exports = { seedSchema, TEMPLATE_PATH };
