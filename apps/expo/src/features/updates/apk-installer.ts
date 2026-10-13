import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";

import { downloadProgress, type AndroidUpdateManifest } from "./android-update";

// Intent.FLAG_GRANT_READ_URI_PERMISSION: the package installer reads the APK
// through our FileProvider content:// URI, not the private file path.
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const APK_MIME = "application/vnd.android.package-archive";

export type ApkDownload = {
  promise: Promise<string>;
  cancel: () => Promise<void>;
};

function apkPath(manifest: AndroidUpdateManifest): string {
  return `${FileSystem.cacheDirectory}update-${manifest.versionCode}.apk`;
}

/**
 * Downloads the APK into the cache directory, reporting progress in [0, 1].
 * Resolves to the local file URI. A size mismatch against the manifest is
 * treated as a failed download (truncated transfer, captive portal page).
 *
 * No sha256 check here: hashing tens of MB in JS is slow, and Android refuses
 * to install over the current app unless the APK carries the same signing key.
 */
export function downloadApk(
  manifest: AndroidUpdateManifest,
  onProgress: (fraction: number) => void,
): ApkDownload {
  const target = apkPath(manifest);
  const task = FileSystem.createDownloadResumable(manifest.url, target, {}, (p) => {
    onProgress(downloadProgress(p.totalBytesWritten, p.totalBytesExpectedToWrite || manifest.size));
  });

  const promise = (async () => {
    const result = await task.downloadAsync();
    if (!result || result.status < 200 || result.status >= 300) {
      throw new Error(`download failed (HTTP ${result?.status ?? "?"})`);
    }
    if (manifest.size > 0) {
      const info = await FileSystem.getInfoAsync(result.uri);
      if (!info.exists || info.size !== manifest.size) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true });
        throw new Error("downloaded file is incomplete");
      }
    }
    return result.uri;
  })();

  return {
    promise,
    cancel: async () => {
      try {
        await task.cancelAsync();
      } finally {
        await FileSystem.deleteAsync(target, { idempotent: true });
      }
    },
  };
}

/**
 * Hands the APK to the system package installer. On first use Android sends
 * the user to "Install unknown apps" for this app (REQUEST_INSTALL_PACKAGES).
 */
export async function installApk(fileUri: string): Promise<void> {
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
    type: APK_MIME,
  });
}
