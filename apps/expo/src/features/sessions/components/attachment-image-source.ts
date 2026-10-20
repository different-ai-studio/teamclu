import { useEffect, useState } from "react";
import type { ImageURISource } from "react-native";

import { cloudApiBaseUrl, supabaseAccessToken } from "../../../lib/cloud-api/client";
import { supabase } from "../../../lib/supabase/client";

const getAccessToken = supabaseAccessToken(supabase);

/** `GET /v1/attachments/:path` is caller-scoped: it answers 401 without the bearer. */
export function needsCloudAuth(url: string): boolean {
  let base: string;
  try {
    base = cloudApiBaseUrl().replace(/\/+$/, "");
  } catch {
    return false;
  }
  return url.startsWith(`${base}/v1/attachments/`);
}

/**
 * The image source for an attachment URL. A public object URL loads as is; a
 * file known only by its bucket path (an iOS upload) goes through the Cloud
 * API with the user's token, so the source stays null until it is read.
 */
export function useAttachmentImageSource(url: string): ImageURISource | null {
  const authed = needsCloudAuth(url);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!authed) return;
    let live = true;
    void getAccessToken()
      .then((value) => {
        if (live) setToken(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [authed, url]);
  if (!authed) return { uri: url };
  return token ? { uri: url, headers: { Authorization: `Bearer ${token}` } } : null;
}
