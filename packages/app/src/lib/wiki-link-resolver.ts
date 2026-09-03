import { exists, readDir, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { buildFileMap, resolveWikiLink, type WikiFileMap } from "@/lib/wiki-link-index";

// Standalone wiki-link resolution against a knowledge tree, addressed by its
// ABSOLUTE root. Callers pass the root the open document lives under — normally
// the daemon's real `~/.amuxd[-<brand>]/teams/<id>/shared/knowledge`, the same
// directory the OSS sync engine owns. (A document opened from the workspace
// file panel arrives under the `team-knowledge` symlink instead; that path is a
// valid root too, and links resolve within whichever one the document came from
// so a click never re-opens the same file under a second path.)
//
// Maps are cached here because the store that used to own that cache is gone
// and every click would otherwise re-walk the whole tree, one IPC round-trip
// per directory.

/**
 * Depth cap for the walk. A knowledge tree can hold symlinks of its own, so
 * bound the recursion rather than hang.
 */
const MAX_DEPTH = 12;

/**
 * How long a built map stays usable. Long enough that a burst of link clicks
 * costs one walk; short enough that a teammate's freshly synced note resolves
 * without restarting the app.
 */
const CACHE_TTL_MS = 5_000;

const cache = new Map<string, { at: number; map: WikiFileMap }>();

/** Drop a cached map (or all of them) after something writes into the tree. */
function invalidateWikiFileMap(rootDir?: string): void {
  if (rootDir === undefined) {
    cache.clear();
    return;
  }
  cache.delete(rootDir);
}

async function readDirRecursive(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    const entries = await readDir(dir);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(`${dir}/${entry.name}`, rel, depth + 1);
      } else {
        results.push(rel);
      }
    }
  }
  await walk(rootPath, "", 0);
  return results;
}

/** Map of page name → path relative to `rootDir`. */
async function buildWikiFileMap(rootDir: string): Promise<WikiFileMap> {
  const hit = cache.get(rootDir);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.map;
  }
  try {
    const relFiles = await readDirRecursive(rootDir);
    const map = buildFileMap(relFiles);
    cache.set(rootDir, { at: Date.now(), map });
    return map;
  } catch {
    // Either the dir is missing (no team onboarded yet) or the walk failed
    // midway. Deliberately not cached: an empty map parked for the whole TTL
    // would keep every link "unresolved", and callers treat that as "create a
    // new note".
    return new Map();
  }
}

/** Absolute path of the note `target` names, or null when it does not exist. */
export async function resolveWikiLinkPath(
  rootDir: string,
  target: string,
): Promise<string | null> {
  const map = await buildWikiFileMap(rootDir);
  const rel = resolveWikiLink(map, target);
  return rel === null ? null : `${rootDir}/${rel}`;
}

export async function createNoteFromLink(
  rootDir: string,
  pageName: string,
): Promise<string> {
  const clean = pageName.trim();
  if (!clean) {
    throw new Error("Page name cannot be empty");
  }
  if (clean.includes("..") || clean.startsWith("/") || clean.includes("\\")) {
    throw new Error(`Invalid page name: ${pageName}`);
  }
  // Never materialize the root itself. When it is the `team-knowledge` symlink,
  // creating it as a real directory would shadow the link for good
  // (`ensure_link_to` sees `is_dir()` and returns Fallback on every later call),
  // so notes written into it would never sync. When it is the real knowledge
  // dir, its absence means no team is onboarded yet. Either way: wait.
  if (!(await exists(rootDir))) {
    throw new Error(`Team knowledge directory is not available yet: ${rootDir}`);
  }
  const filePath = `${rootDir}/${clean}.md`;
  // Never clobber an existing note. Resolution returns an empty map on a
  // transient walk failure, which reads as "unresolved" and lands here — that
  // must not overwrite a real note with an empty frontmatter stub.
  if (await exists(filePath)) {
    return filePath;
  }
  const lastSlash = filePath.lastIndexOf("/");
  const parentDir = filePath.slice(0, lastSlash);
  // Safe now that `rootDir` is known to exist: this can only create
  // subdirectories *inside* the knowledge tree, never the root itself.
  if (parentDir !== rootDir) {
    await mkdir(parentDir, { recursive: true });
  }
  const now = new Date().toISOString();
  const content = `---\ntitle: ${clean}\ncreated: ${now}\nupdated: ${now}\n---\n\n`;
  await writeTextFile(filePath, content);
  invalidateWikiFileMap(rootDir);
  return filePath;
}
