export function getCommandText(
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return "";
  return (
    (typeof args.command === "string" ? args.command : null) ||
    (typeof args.cmd === "string" ? args.cmd : null) ||
    (typeof args.input === "string" ? args.input : null) ||
    ""
  );
}

function contentTextFromValue(value: unknown): string {
  if (!Array.isArray(value)) return "";

  return value
    .map((item: unknown) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";

      const itemObj = item as Record<string, unknown>;
      if (typeof itemObj.text === "string") return itemObj.text;
      return textFromToolResult(itemObj.content);
    })
    .filter((text) => text.trim())
    .join("\n");
}

function textFromToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return contentTextFromValue(result);
  if (result && typeof result === "object") {
    const resultObj = result as Record<string, unknown>;
    for (const key of ["raw", "output", "result", "text", "metadata"]) {
      const text = textFromToolResult(resultObj[key]);
      if (text.trim()) return text;
    }

    const stdio = ["stdout", "stderr"]
      .map((key) => textFromToolResult(resultObj[key]))
      .filter((text) => text.trim());
    if (stdio.length > 0) return stdio.join("\n");

    return contentTextFromValue(resultObj.content);
  }
  return "";
}

function commandDescriptionValues(
  args: Record<string, unknown> | undefined,
): Set<string> {
  const values = new Set<string>();
  if (!args) return values;
  for (const key of ["_description", "description", "summary", "title", "action"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      values.add(value.trim());
    }
  }
  return values;
}

export function getToolCallOutputText(
  result: unknown,
  args?: Record<string, unknown>,
): string {
  const output = textFromToolResult(result);
  if (!output.trim()) return "";
  if (commandDescriptionValues(args).has(output.trim())) {
    return "";
  }
  return output;
}
