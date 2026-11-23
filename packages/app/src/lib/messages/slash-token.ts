/**
 * Parse the body of a `/…` composer chip token (`role:<name>`,
 * `skill:<name>`, `command:<name>`; a bare name is a skill).
 *
 * The composer that writes the token, the send path that reads it and the
 * message renderer that draws it must agree, so all three import this one
 * function.
 */
export type SlashTokenType = "role" | "skill" | "command";

export function parseSlashToken(body: string): { type: SlashTokenType; name: string } {
  if (body.startsWith("role:")) return { type: "role", name: body.slice("role:".length) };
  if (body.startsWith("skill:")) return { type: "skill", name: body.slice("skill:".length) };
  if (body.startsWith("command:")) return { type: "command", name: body.slice("command:".length) };
  return { type: "skill", name: body };
}
