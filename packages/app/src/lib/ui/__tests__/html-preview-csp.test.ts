import { describe, expect, it } from 'vitest';
import { HTML_PREVIEW_CSP, withHtmlPreviewCsp } from '@/lib/ui/html-preview-csp';

describe('withHtmlPreviewCsp', () => {
  it('denies the four directives a preview must not have', () => {
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'");
    expect(HTML_PREVIEW_CSP).toContain("base-uri 'none'");
    expect(HTML_PREVIEW_CSP).toContain("object-src 'none'");
  });

  it('leaves script/style/img alone so pages still render', () => {
    expect(HTML_PREVIEW_CSP).not.toContain('script-src');
    expect(HTML_PREVIEW_CSP).not.toContain('style-src');
    expect(HTML_PREVIEW_CSP).not.toContain('img-src');
    expect(HTML_PREVIEW_CSP).not.toContain('default-src');
  });

  it('inserts the meta as the first child of an existing head', () => {
    const out = withHtmlPreviewCsp(
      '<!doctype html><html><head><script src="x.js"></script></head><body>hi</body></html>',
    );
    expect(out).toMatch(/<head><meta http-equiv="Content-Security-Policy"/i);
    // Ahead of the document's own subresource, or it governs nothing.
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('x.js'));
  });

  it('keeps the doctype first so the preview does not fall into quirks mode', () => {
    const out = withHtmlPreviewCsp('<!DOCTYPE html>\n<html><head></head><body></body></html>');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('synthesises a head when the document has html but no head', () => {
    const out = withHtmlPreviewCsp('<!doctype html><html><body>hi</body></html>');
    expect(out).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<body>'));
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('stays behind a doctype on a bare fragment', () => {
    const out = withHtmlPreviewCsp('<!doctype html>\n<p>fragment</p>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<p>'));
  });

  it('prepends to a fragment with no doctype and no head', () => {
    const out = withHtmlPreviewCsp('<p>fragment</p>');
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('matches head/html case-insensitively and with attributes', () => {
    const out = withHtmlPreviewCsp('<HTML lang="en"><HEAD data-x="1"><title>t</title></HEAD></HTML>');
    expect(out).toMatch(/<HEAD data-x="1"><meta http-equiv="Content-Security-Policy"/);
  });

  it('still emits a policy for empty content', () => {
    expect(withHtmlPreviewCsp('')).toContain('Content-Security-Policy');
  });
});
