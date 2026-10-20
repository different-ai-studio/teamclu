import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";

import { supabaseAccessToken } from "../../lib/cloud-api/client";
import { supabase } from "../../lib/supabase/client";
import { uuidV4 } from "../../lib/uuid";
import { uploadAttachment } from "../sessions/attachment-upload";
import type { ComposerAttachment } from "./components/IdeaImageAttachmentStrip";

/**
 * Picking + uploading for idea images, shared by the create sheet and the
 * detail screen's progress composer (iOS shares `addImageAttachment` between
 * `CreateIdeaSheet` and `IdeaDetailView` the same way).
 *
 * Uploads land under `ideas/<contextId>` so idea attachments never collide with
 * a session's storage namespace — the same path convention iOS uses.
 */

export type IdeaImageSource = "library" | "camera";

const MAX_LIBRARY_SELECTION = 5;

/**
 * JPEG quality the picker re-encodes at before upload — iOS
 * `IdeaImagePreparation.uploadQuality`. iOS also caps the long edge at
 * 1600px; the picker has no resize option and expo-image-manipulator isn't a
 * dependency, so here the re-encode is the whole downsample. It still keeps a
 * full-sensor photo from going up untouched, which is what made feed rows
 * slow to paint.
 */
export const IDEA_UPLOAD_QUALITY = 0.8;

export type IdeaImageAttachments = {
  attachments: ComposerAttachment[];
  /** Uploaded, ready-to-post public URLs, in pick order. */
  uploadedUrls: string[];
  hasPendingUploads: boolean;
  hasFailedUploads: boolean;
  addImages: (source: IdeaImageSource) => Promise<void>;
  removeAttachment: (id: string) => void;
  reset: () => void;
};

export function useIdeaImageAttachments(args: {
  teamId: string;
  contextId: string;
  onError?: (message: string) => void;
}): IdeaImageAttachments {
  const { teamId, contextId, onError } = args;
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

  const addImages = useCallback(
    async (source: IdeaImageSource) => {
      if (!teamId || !contextId) {
        onError?.("Image upload is unavailable for this team.");
        return;
      }
      let assets: ImagePicker.ImagePickerAsset[];
      try {
        const permission =
          source === "camera"
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          onError?.(
            source === "camera" ? "Camera permission denied." : "Photo permission denied.",
          );
          return;
        }
        const result =
          source === "camera"
            ? await ImagePicker.launchCameraAsync({
                allowsEditing: false,
                quality: IDEA_UPLOAD_QUALITY,
              })
            : await ImagePicker.launchImageLibraryAsync({
                allowsEditing: false,
                allowsMultipleSelection: true,
                mediaTypes: ["images"],
                quality: IDEA_UPLOAD_QUALITY,
                selectionLimit: MAX_LIBRARY_SELECTION,
              });
        if (result.canceled || result.assets.length === 0) return;
        assets = result.assets;
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Couldn't open the picker.");
        return;
      }

      for (const asset of assets) {
        const id = uuidV4();
        setAttachments((prev) => [
          ...prev,
          { id, localUri: asset.uri, remoteUrl: null, state: "uploading" },
        ]);
        try {
          const uploaded = await uploadAttachment({
            getAccessToken: supabaseAccessToken(supabase),
            teamId,
            sessionId: `ideas/${contextId}`,
            localUri: asset.uri,
            fallbackMime: asset.mimeType ?? "image/jpeg",
          });
          setAttachments((prev) =>
            prev.map((item) =>
              item.id === id
                ? { ...item, remoteUrl: uploaded.publicUrl, state: "uploaded" }
                : item,
            ),
          );
        } catch (err) {
          setAttachments((prev) =>
            prev.map((item) => (item.id === id ? { ...item, state: "failed" } : item)),
          );
          onError?.(err instanceof Error ? err.message : "Couldn't upload the image.");
        }
      }
    },
    [contextId, onError, teamId],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const reset = useCallback(() => setAttachments([]), []);

  return {
    attachments,
    uploadedUrls: attachments
      .filter((item) => item.state === "uploaded" && item.remoteUrl)
      .map((item) => item.remoteUrl as string),
    hasPendingUploads: attachments.some((item) => item.state === "uploading"),
    hasFailedUploads: attachments.some((item) => item.state === "failed"),
    addImages,
    removeAttachment,
    reset,
  };
}

/** Copy iOS uses when an idea activity carries images but no typed body. */
export function imageOnlyProgressContent(count: number): string {
  return `Attached ${count} image${count === 1 ? "" : "s"}.`;
}
