interface PersonMentionLabel {
  name: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove @displayName tokens from message body when those people were picked
 * via the mention popover (rendered as UI pills, not prompt text).
 */
export function stripPickerPersonMentionsFromText(
  text: string,
  mentions: readonly PersonMentionLabel[],
): string {
  let result = text;
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;
    const pattern = new RegExp(`@${escapeRegExp(name)}(?=\\s|$)`, "g");
    result = result.replace(pattern, "");
  }
  return result.replace(/[ \t]{2,}/g, " ").trim();
}
