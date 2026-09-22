"use strict";

const { globMatch } = require("./glob");
const { normalizeDocumentsPath } = require("./paths");

const ALLOWED_CLASSES = new Set(["policy", "process", "role", "term", "faq", "training"]);

const SENSITIVE_NAME_RE =
  /保单|处分|入职|身份证|信息收集|人事档案|劳动合同|证件号|salary|insurance|onboarding-pack/i;

function extensionOf(filePath) {
  const base = filePath.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function matchingSource(filePath, config) {
  return config.sources
    .filter((source) => filePath.startsWith(source.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

function classifySource(file, config) {
  const path = normalizeDocumentsPath(file.path);
  const size = Number(file.size) || 0;
  const maxBytes = config.limits?.maxSourceBytes ?? 104857600;

  for (const pattern of config.deny?.pathPatterns || []) {
    if (globMatch(pattern, path)) {
      return { status: "denied", path, reason: `deny pattern ${pattern}` };
    }
  }

  const base = path.split("/").pop() || "";
  if (SENSITIVE_NAME_RE.test(base)) {
    return { status: "denied", path, reason: "sensitive filename" };
  }

  const source = matchingSource(path, config);
  if (!source) {
    return { status: "ignored", path, reason: "outside whitelist prefixes" };
  }

  if (!ALLOWED_CLASSES.has(source.class)) {
    return {
      status: "blocked_needs_classification",
      path,
      reason: `unknown class ${source.class}`,
    };
  }

  const ext = extensionOf(path);
  if (!source.allowExtensions.includes(ext)) {
    return { status: "blocked_unsupported_extension", path, reason: `extension ${ext || "(none)"}` };
  }

  if (size > maxBytes) {
    return { status: "blocked_too_large", path, reason: `size ${size}` };
  }

  return {
    status: "allowed",
    path,
    class: source.class,
    priority: source.priority,
    size,
  };
}

module.exports = { ALLOWED_CLASSES, classifySource };
