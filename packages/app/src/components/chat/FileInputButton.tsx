import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { capabilities } from "@/lib/config/platform";
import { readDesktopPathsAsFiles } from "@/lib/workspace/read-desktop-files";
import { exceedsNonImageLimit } from "@/lib/attachments/attachment-constants";

interface FileInputButtonProps {
  /** Selected or pasted files ready for cloud upload. */
  onFilesSelected: (files: File[]) => void;
}

export function FileInputButton({ onFilesSelected }: FileInputButtonProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const rejectOversize = React.useCallback(async (names: string[]) => {
    if (names.length === 0) return;
    const { toast } = await import("sonner");
    toast.error(
      names.length === 1
        ? `"${names[0]}" exceeds the 20MB limit`
        : `${names.length} files exceed the 20MB limit`,
    );
  }, []);

  const handleClick = async () => {
    if (!capabilities.tauriInvoke) {
      inputRef.current?.click();
      return;
    }

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        title: "Select Files",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      const { files, oversize, failed } = await readDesktopPathsAsFiles(paths);
      if (oversize.length > 0) void rejectOversize(oversize);
      if (failed.length > 0) {
        const { toast } = await import("sonner");
        toast.error(
          failed.length === 1
            ? `Could not read "${failed[0]}"`
            : `Could not read ${failed.length} files`,
        );
      }
      if (files.length > 0) onFilesSelected(files);
    } catch (error) {
      console.error("[FileInput] Failed to open file dialog:", error);
    }
  };

  const handleBrowserChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const accepted = all.filter((f) => !exceedsNonImageLimit(f));
    const oversize = all.filter((f) => exceedsNonImageLimit(f)).map((f) => f.name);
    if (oversize.length > 0) void rejectOversize(oversize);
    if (accepted.length > 0) onFilesSelected(accepted);
    e.target.value = "";
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={handleClick}
        aria-label="Attach files"
      >
        <Plus className="h-4 w-4" />
      </Button>
      {!capabilities.tauriInvoke ? (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="file-input-browser"
          onChange={handleBrowserChange}
        />
      ) : null}
    </>
  );
}
