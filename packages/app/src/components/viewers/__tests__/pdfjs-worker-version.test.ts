import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * PDFViewer takes the pdf.js *API* from `react-pdf` (which vendors its own
 * exact `pdfjs-dist`) but points `GlobalWorkerOptions.workerSrc` at our
 * top-level `pdfjs-dist`. pdf.js compares the two with `!==` and throws
 *
 *   The API version "x" does not match the Worker version "y".
 *
 * on any difference — not just a major one. So the two have to resolve to the
 * same package, which only holds while our pin equals what react-pdf vendors.
 *
 * That drifted once already: react-pdf sat on 5.4.296 while dependabot walked
 * our pin up through 6.x, and nothing caught it because no test loads a PDF.
 * Nothing can, cheaply — importing pdf.js under jsdom dies on `DOMMatrix` —
 * so this compares the two resolutions by their package metadata instead.
 */
describe('pdfjs-dist worker/API pinning', () => {
  // Anchor on the package root rather than import.meta.url: vitest transforms
  // this file for jsdom, where import.meta.url is an http:// URL that
  // createRequire rejects.
  const packageRoot = process.cwd();
  const requireFromApp = createRequire(path.join(packageRoot, 'package.json'));

  it('anchors on the app package (guards the assertions below)', () => {
    expect(
      existsSync(path.join(packageRoot, 'src/components/viewers/PDFViewer.tsx')),
    ).toBe(true);
  });

  it('resolves the worker and the react-pdf API to the same pdfjs-dist version', () => {
    // The specifier PDFViewer passes to `new URL(...)` for workerSrc.
    const workerVersion = requireFromApp('pdfjs-dist/package.json').version;

    // The pdfjs instance `import { pdfjs } from 'react-pdf'` actually hands us.
    const requireFromReactPdf = createRequire(
      requireFromApp.resolve('react-pdf'),
    );
    const apiVersion = requireFromReactPdf('pdfjs-dist/package.json').version;

    expect(workerVersion).toBe(apiVersion);
  });
});
