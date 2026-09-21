"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dryRun } = require("./dry-run");
const { loadConfig } = require("./config");
const { extensionOf } = require("./extract-text");
const { parsePages } = require("./extract-pdf");

function sourceAbs(documentsRoot, documentsPath) {
  return path.join(documentsRoot, documentsPath.slice("documents/".length));
}

function roundMoney(value) {
  return Math.round(value * 10000) / 10000;
}

async function estimateVision(opts) {
  const config = loadConfig(opts.configPath);
  const planResult = dryRun(opts);
  const items = [...planResult.plan.add, ...planResult.plan.update];
  const sources = [];
  let visionPages = 0;

  for (const item of items) {
    if (extensionOf(item.path) !== "pdf") continue;
    const abs = sourceAbs(opts.documentsRoot, item.path);
    if (!fs.existsSync(abs)) continue;
    const pages = parsePages(fs.readFileSync(abs));
    const failed = pages.filter((page) => page.quality !== "accepted");
    if (failed.length === 0) continue;
    visionPages += failed.length;
    sources.push({
      path: item.path,
      pages: failed.length,
      reason: failed[0].quality === "low" ? "image-only-or-short" : failed[0].quality,
    });
  }

  sources.sort((a, b) => a.path.localeCompare(b.path));
  const unitPrice = Number(config.models?.visionPagePrice);
  const hasPrice = Number.isFinite(unitPrice);
  return {
    ok: true,
    visionPages,
    unitPrice: hasPrice ? unitPrice : null,
    estimatedCost: hasPrice ? roundMoney(visionPages * unitPrice) : null,
    currency: config.models?.currency || "CNY",
    requiresAccept: visionPages > 0,
    sources,
    plan: planResult.plan,
  };
}

function assertVisionEstimateAccepted(estimate, acceptVisionEstimate) {
  if (!estimate?.requiresAccept) return;
  if (!acceptVisionEstimate) {
    throw new Error("vision estimate must be accepted with --accept-vision-estimate");
  }
}

module.exports = { estimateVision, assertVisionEstimateAccepted };
