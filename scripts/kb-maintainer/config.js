"use strict";

const { normalizeDocumentsPrefix, prefixesOverlap } = require("./paths");

const DEFAULT_LIMITS = {
  maxPagesChangedPerSource: 15,
  maxSourceBytes: 104857600,
  maxExtractedChars: 50000,
  maxAgentMinutesPerSource: 20,
  maxAgentTokensPerSource: 120000,
  maxBatchSources: 100,
  maxIndexChars: 8000,
  maxSourceSummaryChars: 4000,
  maxSourceSummaryPagesPerSource: 1,
  maxVisionPages: 30,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseConfig(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("config must be an object");
  }
  if (raw.schemaVersion !== 1) {
    throw new Error("unsupported config schemaVersion");
  }
  if (typeof raw.teamId !== "string" || !UUID_RE.test(raw.teamId)) {
    throw new Error("config.teamId is required");
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    throw new Error("config.sources must be a non-empty array");
  }

  const sources = raw.sources.map((source, index) => {
    if (!source || typeof source !== "object") {
      throw new Error(`config.sources[${index}] is invalid`);
    }
    const prefix = normalizeDocumentsPrefix(source.prefix);
    if (typeof source.class !== "string" || source.class.trim() === "") {
      throw new Error(`config.sources[${index}].class is required`);
    }
    const priority = Number(source.priority);
    if (!Number.isFinite(priority)) {
      throw new Error(`config.sources[${index}].priority is required`);
    }
    if (!Array.isArray(source.allowExtensions) || source.allowExtensions.length === 0) {
      throw new Error(`config.sources[${index}].allowExtensions is required`);
    }
    return {
      prefix,
      class: source.class.trim(),
      priority,
      allowExtensions: source.allowExtensions.map((ext) => String(ext).replace(/^\./, "").toLowerCase()),
    };
  });

  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      if (prefixesOverlap(sources[i].prefix, sources[j].prefix)) {
        throw new Error(`overlapping source prefixes: ${sources[i].prefix} and ${sources[j].prefix}`);
      }
    }
  }

  const denyPatterns = Array.isArray(raw.deny?.pathPatterns) ? raw.deny.pathPatterns.map(String) : [];
  return {
    schemaVersion: 1,
    teamId: raw.teamId,
    sources,
    deny: { pathPatterns: denyPatterns },
    limits: { ...DEFAULT_LIMITS, ...(raw.limits || {}) },
    models: raw.models || {},
  };
}

function loadConfig(filePath, fsImpl = require("node:fs")) {
  const text = fsImpl.readFileSync(filePath, "utf8");
  return parseConfig(JSON.parse(text));
}

module.exports = { DEFAULT_LIMITS, parseConfig, loadConfig };
