"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dryRun } = require("./dry-run");
const { loadConfig } = require("./config");
const { extensionOf } = require("./extract-text");
const { parsePages } = require("./extract-pdf");
const { imageLooksReadable } = require("./vision");

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

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
  const unreadable = [];
  const overLimit = [];
  let visionPages = 0;
  const maxVisionPages = config.limits?.maxVisionPages ?? 30;

  for (const item of items) {
    const ext = extensionOf(item.path);
    const abs = sourceAbs(opts.documentsRoot, item.path);
    if (!fs.existsSync(abs)) continue;
    if (IMAGE_EXTS.has(ext)) {
      const bytes = fs.readFileSync(abs);
      if (!imageLooksReadable(ext, bytes)) {
        unreadable.push({ path: item.path, reason: "unreadable" });
        continue;
      }
      visionPages += 1;
      sources.push({ path: item.path, pages: 1, reason: "image" });
      continue;
    }
    if (ext !== "pdf") continue;
    let pages = [];
    try {
      pages = parsePages(fs.readFileSync(abs));
    } catch {
      unreadable.push({ path: item.path, reason: "unreadable" });
      continue;
    }
    if (pages.length === 0) {
      unreadable.push({ path: item.path, reason: "unreadable" });
      continue;
    }
    const failed = pages.filter((page) => page.quality !== "accepted");
    if (failed.length === 0) continue;
    if (failed.length > maxVisionPages) {
      overLimit.push({ path: item.path, pages: failed.length, limit: maxVisionPages });
      continue;
    }
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
    requiresAccept: visionPages > 0 || unreadable.length > 0 || overLimit.length > 0,
    sources,
    unreadable,
    overLimit,
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
