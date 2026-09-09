import { useState, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  FileType,
  ZoomIn,
  ZoomOut,
  Loader2,
  ChevronUp,
  ChevronDown,
  AlertCircle,
} from "lucide-react";

// Configure PDF.js worker - use local file via Vite ?url import.
//
// The API above comes from react-pdf's own vendored pdfjs-dist; this worker
// comes from our top-level one. pdf.js compares the two with `!==` and throws
// `The API version "x" does not match the Worker version "y"` on ANY
// difference, so our `pdfjs-dist` pin must stay equal to whatever react-pdf
// depends on — bump the two together, never alone. `viewers/__tests__/
// pdfjs-worker-version.test.ts` fails when they drift.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PDFViewerProps {
  content: string;
  filename: string;
  filePath: string;
  onClose?: () => void;
}

export default function PDFViewer({
  content,
  filePath,
}: PDFViewerProps) {
  const { t } = useTranslation();
  const [numPages, setNumPages] = useState<number | null>(null);
  const [scale, setScale] = useState(1.0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Convert data URL to Uint8Array for react-pdf
  const fileData = useMemo(() => {
    try {
      const base64 = content.split(",")[1];
      if (!base64) return content;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { data: bytes };
    } catch {
      return content;
    }
  }, [content]);

  const onDocumentLoadSuccess = useCallback(
    ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
      setLoadError(null);
    },
    [],
  );

  const onDocumentLoadError = useCallback((error: Error) => {
    console.error("[PDFViewer] Failed to load PDF:", error);
    setLoadError(error.message);
  }, []);

  const handleZoomIn = () => setScale((prev) => Math.min(prev + 0.25, 3.0));
  const handleZoomOut = () => setScale((prev) => Math.max(prev - 0.25, 0.5));

  const scrollToPage = useCallback(
    (page: number) => {
      if (page < 1 || (numPages && page > numPages)) return;
      const el = pageRefs.current.get(page);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setCurrentPage(page);
      }
    },
    [numPages],
  );

  // Track current page on scroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !numPages) return;

    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 3;

    for (let i = 1; i <= numPages; i++) {
      const el = pageRefs.current.get(i);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= containerCenter && rect.bottom > containerCenter) {
          setCurrentPage(i);
          break;
        }
      }
    }
  }, [numPages]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center h-10 px-3 border-b bg-muted/30 shrink-0 gap-3">
        {/* Full file path */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileType className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{filePath}</span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 ml-auto">
          {/* Page navigation */}
          {numPages && numPages > 1 && (
            <div className="flex items-center gap-0.5 mr-2">
              <button
                className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-30"
                onClick={() => scrollToPage(currentPage - 1)}
                disabled={currentPage <= 1}
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <span className="text-xs text-muted-foreground min-w-[4rem] text-center">
                {currentPage} / {numPages}
              </span>
              <button
                className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-30"
                onClick={() => scrollToPage(currentPage + 1)}
                disabled={currentPage >= numPages}
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Zoom controls */}
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleZoomOut}
            disabled={scale <= 0.5}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground w-10 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleZoomIn}
            disabled={scale >= 3.0}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* PDF content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-muted/20"
        onScroll={handleScroll}
      >
        {loadError ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <AlertCircle className="h-12 w-12 opacity-50 text-destructive" />
            <p className="text-sm font-medium">
              {t("app.pdfLoadError", "Failed to load PDF")}
            </p>
            <p className="text-xs text-muted-foreground/70 max-w-md text-center">
              {loadError}
            </p>
          </div>
        ) : (
          <Document
            file={fileData}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <div className="flex flex-col items-center py-4 gap-4">
              {numPages &&
                Array.from({ length: numPages }, (_, i) => i + 1).map(
                  (pageNumber) => (
                    <div
                      key={pageNumber}
                      ref={(el) => {
                        if (el) pageRefs.current.set(pageNumber, el);
                      }}
                      className="shadow-md"
                    >
                      <Page
                        pageNumber={pageNumber}
                        scale={scale}
                        loading={
                          <div className="flex items-center justify-center p-8">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        }
                      />
                    </div>
                  ),
                )}
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}
