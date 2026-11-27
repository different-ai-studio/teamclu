/** Shared by the boundary tests in this directory. */

/**
 * The source with every comment replaced by spaces (newlines kept, so line
 * numbers still match). Strings and template literals are copied as they are;
 * a regex literal containing a quote could confuse it, which no file here has.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
    } else if (c === "\"" || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") { out += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
        out += text[i]; i++;
      }
      out += text[i] ?? ""; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}
