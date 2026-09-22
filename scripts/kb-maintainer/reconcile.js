"use strict";

function compareItems(a, b) {
  const priority = (a.priority ?? 1000) - (b.priority ?? 1000);
  if (priority !== 0) return priority;
  return a.path.localeCompare(b.path);
}

function extractorChanged(current, previous) {
  if (!current.extractorCacheKey || !previous?.extractorCacheKey) return false;
  return current.extractorCacheKey !== previous.extractorCacheKey;
}

function reconcile({ current, state }) {
  const queues = {
    add: [],
    update: [],
    delete: [],
    unchanged: [],
    would_fetch: [],
  };
  const previous = state?.sources && typeof state.sources === "object" ? state.sources : {};
  const seen = new Set();

  for (const item of current) {
    seen.add(item.path);
    if (!item.sourceSha256) {
      queues.would_fetch.push({ ...item });
      continue;
    }
    const prior = previous[item.path];
    if (!prior) {
      queues.add.push({ ...item });
      continue;
    }
    if (prior.sourceSha256 !== item.sourceSha256 || extractorChanged(item, prior)) {
      queues.update.push({ ...item, previousSha256: prior.sourceSha256 });
      continue;
    }
    // A prior import that recorded no pages never landed in the wiki — recompile.
    if (!Array.isArray(prior.affectedPages) || prior.affectedPages.length === 0) {
      queues.update.push({ ...item, previousSha256: prior.sourceSha256 });
      continue;
    }
    queues.unchanged.push({ ...item });
  }

  for (const path of Object.keys(previous).sort()) {
    if (!seen.has(path)) {
      queues.delete.push({ path, sourceSha256: previous[path].sourceSha256 });
    }
  }

  for (const key of Object.keys(queues)) {
    queues[key].sort(compareItems);
  }
  return queues;
}

module.exports = { reconcile };
