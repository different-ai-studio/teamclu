import { exists, readDir, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { buildFileMap, resolveWikiLink, type WikiFileMap } from "@/lib/wiki-link-index";

// Standalone wiki-link resolution against a workspace subdirectory (the
// team-shared knowledge dir surfaced as `team-knowledge`). The previous
// implementation lived on the RAG knowledge store, which built and cached a
// file map from `knowledge/`. With the RAG module removed, wiki links resolve
// against the symlinked team knowledge dir instead — cached here, because the
// store that used to own that cache is gone and every click would otherwise
// re-walk the whole tree, one IPC round-trip per directory.

/**
 * Depth cap for the walk. `team-knowledge` is a symlink and nothing stops a
 * note tree from holding another one, so bound the recursion rather than hang.
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
export function invalidateWikiFileMap(workspacePath?: string, subdir?: string): void {
  if (workspacePath === undefined || subdir === undefined) {
    cache.clear();
    return;
  }
  cache.delete(`${workspacePath}/${subdir}`);
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

export async function buildWikiFileMap(
  workspacePath: string,
  subdir: string,
): Promise<WikiFileMap> {
  const dir = `${workspacePath}/${subdir}`;
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.map;
  }
  try {
    const relFiles = await readDirRecursive(dir);
    const map = buildFileMap(relFiles.map((f) => `${subdir}/${f}`));
    cache.set(dir, { at: Date.now(), map });
    return map;
  } catch {
    // Either the dir is missing (no team link yet) or the walk failed midway.
    // Deliberately not cached: an empty map parked for the whole TTL would keep
    // every link "unresolved", and callers treat that as "create a new note".
    return new Map();
  }
}

export async function resolveWikiLinkPath(
  workspacePath: string,
  subdir: string,
  target: string,
): Promise<string | null> {
  const map = await buildWikiFileMap(workspacePath, subdir);
  return resolveWikiLink(map, target);
}

export async function createNoteFromLink(
  workspacePath: string,
  subdir: string,
  pageName: string,
): Promise<string> {
  const clean = pageName.trim();
  if (!clean) {
    throw new Error("Page name cannot be empty");
  }
  if (clean.includes("..") || clean.startsWith("/") || clean.includes("\\")) {
    throw new Error(`Invalid page name: ${pageName}`);
  }
  const targetDir = `${workspacePath}/${subdir}`;
  // `team-knowledge` is a daemon-managed symlink into the team's synced
  // `shared/knowledge`. Materializing it here as a real directory would shadow
  // that link permanently — `ensure_link_to` sees `is_dir()` and returns
  // Fallback on every later call — so notes written into it would never sync
  // and the team's actual knowledge would never appear. Wait for the daemon.
  if (!(await exists(targetDir))) {
    throw new Error(`Team knowledge directory is not available yet: ${targetDir}`);
  }
  const filePath = `${targetDir}/${clean}.md`;
  // Never clobber an existing note. Resolution returns an empty map on a
  // transient walk failure, which reads as "unresolved" and lands here — that
  // must not overwrite a real note with an empty frontmatter stub.
  if (await exists(filePath)) {
    return filePath;
  }
  const lastSlash = filePath.lastIndexOf("/");
  const parentDir = filePath.slice(0, lastSlash);
  // Safe now that `targetDir` is known to exist: this can only create
  // subdirectories *inside* the knowledge tree, never the link itself.
  if (parentDir !== targetDir) {
    await mkdir(parentDir, { recursive: true });
  }
  const now = new Date().toISOString();
  const content = `---\ntitle: ${clean}\ncreated: ${now}\nupdated: ${now}\n---\n\n`;
  await writeTextFile(filePath, content);
  invalidateWikiFileMap(workspacePath, subdir);
  return filePath;
}
