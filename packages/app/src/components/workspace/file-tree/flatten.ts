//! Filtering and flattening the tree for the virtualizer.
//!
//! Pure: everything here takes nodes and returns nodes, so the row maths is
//! testable without mounting the tree.

import { type FileNode } from "@/stores/workspace";

// Flattened tree node for virtualization
export interface FlatTreeNode {
  node: FileNode;
  level: number;
  /** Display name for compact folders, e.g. "src/main/java" */
  compactName?: string;
  /** All directory paths in a compacted chain (for collapsing all at once) */
  compactedPaths?: string[];
}

// Filter tree nodes recursively based on filter text.
// Returns { nodes, autoExpandPaths } where autoExpandPaths contains
// directories that should be auto-expanded because they have matching children.
export function filterTree(
  nodes: FileNode[],
  filterText: string,
  autoExpandPaths: Set<string> = new Set(),
): { nodes: FileNode[]; autoExpandPaths: Set<string> } {
  if (!filterText.trim()) {
    return { nodes, autoExpandPaths };
  }

  const lowerFilter = filterText.toLowerCase();
  const filtered: FileNode[] = [];

  for (const node of nodes) {
    const matchesFilter = node.name.toLowerCase().includes(lowerFilter);

    // If it's a directory, check if any children match
    let matchingChildren: FileNode[] = [];
    if (node.type === "directory" && node.children) {
      const result = filterTree(node.children, filterText, autoExpandPaths);
      matchingChildren = result.nodes;
    }

    // Include node if:
    // 1. The node itself matches, OR
    // 2. It's a directory with matching children
    if (matchesFilter || matchingChildren.length > 0) {
      if (matchingChildren.length > 0) {
        // Auto-expand directories that have matching children
        autoExpandPaths.add(node.path);
        filtered.push({
          ...node,
          children: matchingChildren,
        });
      } else {
        filtered.push(node);
      }
    }
  }

  return { nodes: filtered, autoExpandPaths };
}

// Flatten the recursive tree into a flat list of visible nodes
export function flattenTree(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  level: number = 0,
  result: FlatTreeNode[] = [],
): FlatTreeNode[] {
  for (const node of nodes) {
    if (node.type === "directory" && expandedPaths.has(node.path) && node.children) {
      // Check for compact folder chain: single directory child only
      let current = node;
      const nameParts = [current.name];
      const chainPaths = [current.path];

      while (
        current.children &&
        current.children.length === 1 &&
        current.children[0].type === "directory" &&
        expandedPaths.has(current.children[0].path)
      ) {
        current = current.children[0];
        nameParts.push(current.name);
        chainPaths.push(current.path);
      }

      if (nameParts.length > 1) {
        result.push({
          node: current,
          level,
          compactName: nameParts.join("/"),
          compactedPaths: chainPaths,
        });
      } else {
        result.push({ node, level });
      }

      if (current.children) {
        flattenTree(current.children, expandedPaths, level + 1, result);
      }
    } else {
      result.push({ node, level });
      if (
        node.type === "directory" &&
        expandedPaths.has(node.path) &&
        node.children
      ) {
        flattenTree(node.children, expandedPaths, level + 1, result);
      }
    }
  }
  return result;
}
