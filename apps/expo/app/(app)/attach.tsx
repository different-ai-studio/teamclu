import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useOnboarding } from "../_layout";
import { uploadAttachment } from "../../src/features/sessions/attachment-upload";
import { appendPendingAttachment } from "../../src/features/sessions/pending-attachments";
import {
  AttachmentDrawerSheet,
  type AttachmentSource,
} from "../../src/features/sessions/screens/AttachmentDrawerSheet";
import { cloudAccessToken } from "../../src/lib/cloud-api/client";
import { cloudAuth } from "../../src/lib/auth/cloud-auth";
import { PermissionPrimerSheet } from "../../src/ui/PermissionPrimerSheet";

type PickedAsset = {
  uri: string;
  mime?: string;
};

export default function AttachRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const teamId = state.currentTeam?.id ?? "";
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [primer, setPrimer] = useState<"camera" | "photos" | null>(null);

  const persist = async (assets: PickedAsset[]) => {
    if (!teamId || !sessionId) {
      setErrorMessage(t("Open a session before attaching files."));
      return;
    }
    setIsUploading(true);
    try {
      for (const asset of assets) {
        const uploaded = await uploadAttachment({
          getAccessToken: cloudAccessToken(cloudAuth),
          teamId,
          sessionId,
          localUri: asset.uri,
          fallbackMime: asset.mime ?? "application/octet-stream",
        });
        appendPendingAttachment(teamId, sessionId, uploaded);
      }
      router.back();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("Couldn't upload the file."));
    } finally {
      setIsUploading(false);
    }
  };

  const launchCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage(t("Camera permission denied."));
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.85,
      });
      if (result.canceled || result.assets.length === 0) return;
      await persist(
        result.assets.map((asset) => ({ uri: asset.uri, mime: asset.mimeType ?? undefined })),
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("Couldn't open the camera."));
    }
  };

  const launchPhotos = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage(t("Photo library permission denied."));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 5,
        quality: 0.85,
      });
      if (result.canceled || result.assets.length === 0) return;
      await persist(
        result.assets.map((asset) => ({ uri: asset.uri, mime: asset.mimeType ?? undefined })),
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("Couldn't open the picker."));
    }
  };

  const handlePick = async (source: AttachmentSource) => {
    setErrorMessage(null);
    if (source === "files") {
      try {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled || result.assets.length === 0) return;
        await persist(
          result.assets.map((asset) => ({ uri: asset.uri, mime: asset.mimeType ?? undefined })),
        );
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : t("Couldn't open the picker."));
      }
      return;
    }

    setPrimer(source === "camera" ? "camera" : "photos");
  };

  const handlePrimerContinue = async () => {
    const which = primer;
    setPrimer(null);
    if (which === "camera") {
      await launchCamera();
    } else if (which === "photos") {
      await launchPhotos();
    }
  };

  return (
    <>
      <AttachmentDrawerSheet
        errorMessage={errorMessage ?? (isUploading ? t("Uploading…") : null)}
        onClose={() => router.back()}
        onPickSource={handlePick}
      />
      <PermissionPrimerSheet
        body={
          primer === "camera"
            ? t("TeamClu needs the camera to capture and attach photos or videos to your sessions.")
            : t("TeamClu needs the photo library so you can choose images and videos to attach.")
        }
        ctaLabel={t("Continue")}
        iconName={primer === "camera" ? "camera-outline" : "images-outline"}
        onCancel={() => setPrimer(null)}
        onContinue={handlePrimerContinue}
        title={primer === "camera" ? t("Allow camera access") : t("Allow photo library access")}
        visible={primer !== null}
      />
    </>
  );
}
