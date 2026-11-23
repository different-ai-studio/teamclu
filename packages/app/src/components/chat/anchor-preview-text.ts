/** Collapse whitespace and cut a thread anchor's text to `maxLength` chars. */
export function anchorPreviewText(content: string, maxLength: number): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}
