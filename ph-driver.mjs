#!/usr/bin/env node
/**
 * Drive a Chrome tab through AppleScript's `execute javascript`.
 *
 *   node ph-driver.mjs '<js expression>'
 *
 * Why not the chrome-control MCP: this Chrome was not launched with
 * --remote-debugging-port, so CDP is unavailable. AppleScript's JavaScript
 * execution needs no relaunch and no debug port, and it is DOM-precise —
 * better than coordinate clicking for filling a long form.
 *
 * Why a file instead of inline: the JS is long and full of quotes; passing it
 * through an osascript -e string is how you get silent mangling.
 *
 * Caveat worth keeping in mind: this cannot see the page. Verification is done
 * by reading values back out of the DOM, which for a form is stronger evidence
 * than a screenshot anyway.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const js = process.argv[2];
if (!js) {
  console.error("usage: node ph-driver.mjs '<js>'");
  process.exit(1);
}

const jsFile = path.join(tmpdir(), `ph-driver-${process.pid}.js`);
writeFileSync(jsFile, js, 'utf8');

const script = `
set jsText to (read POSIX file "${jsFile}")
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t contains "producthunt.com") then
        set jsResult to execute t javascript jsText
        return (URL of t) & return & "---" & return & (jsResult as text)
      end if
    end repeat
  end repeat
  return "NO_PRODUCTHUNT_TAB"
end tell
`;

try {
  const out = execFileSync('osascript', ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
} catch (err) {
  const detail = err.stderr ? err.stderr.toString().trim() : '';
  console.error(`osascript failed: ${detail || err.message}`);
  process.exit(1);
} finally {
  try {
    unlinkSync(jsFile);
  } catch {
    /* best effort */
  }
}
