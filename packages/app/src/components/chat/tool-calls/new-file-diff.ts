/** A unified diff that adds `content` as a new file at `filePath`. */
export function generateNewFileDiff(content: string, filePath: string): string {
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push("new file mode 100644");
  lines.push("--- /dev/null");
  lines.push(`+++ b/${filePath}`);
  const contentLines = content.split("\n");
  lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
  for (const line of contentLines) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}
