import { cn } from "@/lib/utils";

/** Opaque chrome fill inside the composer stack (no blur). */
export const composerGlassFillClass = "bg-paper";

/** Bottom edge between stack rows — one mechanism everywhere. */
export const composerStackRowDividerClass = "border-0 border-b border-border";

/** Full-width chrome row inside the stack. */
export const composerGlassSurfaceClass = cn(composerGlassFillClass, "box-border w-full");

/** Row inside a shared chrome block (approval + agent). */
export const composerGlassChildClass =
  "box-border w-full border-0 bg-paper shadow-none";

/** Single outer card — prototype `.composer-stack`. */
export const composerStackShellClass =
  "box-border w-full overflow-visible rounded-[14px] border border-border bg-paper shadow-[0_6px_28px_-14px_rgba(20,20,15,0.14)]";

export function composerStackFormSlotClass(hasTopChrome: boolean): string {
  return cn(
    "box-border w-full",
    "[&_form]:box-border [&_form]:m-0 [&_form]:block [&_form]:w-full [&_form]:min-w-0",
    "[&_form]:border-0 [&_form]:shadow-none [&_form]:bg-paper",
    hasTopChrome
      ? "[&_form]:rounded-none [&_form]:rounded-b-[14px]"
      : "[&_form]:rounded-[14px]",
  );
}
