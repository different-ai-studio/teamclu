import { readDir, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { buildFileMap, resolveWikiLink, type WikiFileMap } from "@/lib/wiki-link-index";

// Standalone wiki-link resolution against a workspace subdirectory (the
// team-shared knowledge dir surfaced as `team-knowledge`). The previous
// implementation lived on the RAG knowledge store, which built and cached a
// file map from `knowledge/`. With the RAG module removed, wiki links resolve
// on demand against the symlinked team knowledge dir instead.

async function readDirRecursive(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await readDir(dir);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(`${dir}/${entry.name}`, rel);
      } else {
        results.push(rel);
      }
    }
  }
  await walk(rootPath, "");
  return results;
}

export async function buildWikiFileMap(
  workspacePath: string,
  subdir: string,
): Promise<WikiFileMap> {
  const dir = `${workspacePath}/${subdir}`;
  try {
    const relFiles = await readDirRecursive(dir);
    const workspaceRelPaths = relFiles.map((f) => `${subdir}/${f}`);
    return buildFileMap(workspaceRelPaths);
  } catch {
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
  const filePath = `${targetDir}/${clean}.md`;
  const lastSlash = filePath.lastIndexOf("/");
  const parentDir = filePath.slice(0, lastSlash);
  const now = new Date().toISOString();
  const content = `---\ntitle: ${clean}\ncreated: ${now}\nupdated: ${now}\n---\n\n`;
  await mkdir(parentDir, { recursive: true });
  await writeTextFile(filePath, content);
  return filePath;
}
