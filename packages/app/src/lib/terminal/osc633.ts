/**
 * OSC 633 — VS Code-style shell integration protocol.
 *
 * Sub-commands we care about (the payload xterm hands us is everything
 * after `ESC ] 633 ;` up to BEL/ST):
 *
 *   A                          → prompt start (rendered, no state)
 *   B                          → prompt end / command-line start
 *   C                          → command executed (Enter pressed)
 *   D[;<exitcode>]             → command finished
 *   E;<commandline>[;<nonce>]  → the full command line being run
 *   P;<Key>=<Value>            → property (e.g. Cwd=/path)
 *
 * Values in E and P can contain `\xHH` escapes for `;`, `\\`, and other
 * special bytes — see the shell-integration scripts shipped from Rust.
 */

interface Osc633Handlers {
  onCwd?: (cwd: string) => void;
  onCommandStart?: (commandLine: string) => void;
  onCommandFinish?: (exitCode: number | null) => void;
}

export function handleOsc633(data: string, handlers: Osc633Handlers): void {
  const semi = data.indexOf(";");
  const code = semi === -1 ? data : data.slice(0, semi);
  const rest = semi === -1 ? "" : data.slice(semi + 1);

  switch (code) {
    case "A":
    case "B":
    case "C":
      return;
    case "D": {
      const trimmed = rest.trim();
      if (trimmed.length === 0) {
        handlers.onCommandFinish?.(null);
        return;
      }
      const n = Number.parseInt(trimmed, 10);
      handlers.onCommandFinish?.(Number.isFinite(n) ? n : null);
      return;
    }
    case "E": {
      const cmdField = firstField(rest);
      const cmd = decodePayload(cmdField);
      handlers.onCommandStart?.(cmd);
      return;
    }
    case "P": {
      const eq = rest.indexOf("=");
      if (eq === -1) return;
      const key = rest.slice(0, eq);
      const val = decodePayload(rest.slice(eq + 1));
      if (key === "Cwd") handlers.onCwd?.(val);
      return;
    }
    default:
      return;
  }
}

/** Return everything up to the first unescaped semicolon. */
function firstField(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      out += ch + s[i + 1];
      i += 1;
      continue;
    }
    if (ch === ";") break;
    out += ch;
  }
  return out;
}

/** Decode `\xHH` and `\\` escapes emitted by the shell integration script. */
function decodePayload(s: string): string {
  return s
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\/g, "\\");
}
