import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, StyleSheet, View } from "react-native";

import { hai } from "../../../ui/theme";
import { ImageLightbox } from "../../sessions/components/ImageLightbox";
import { feedMediaTiles } from "../idea-feed";

/**
 * An idea's own pictures, sized as media rather than as the thumbnail strip a
 * comment's attachments get: one fills the column, several share a two-up
 * grid. Ported from iOS `IdeaFeedMedia`, and shared by the feed card and the
 * idea detail so a picture is the same size in both places. Tapping a tile
 * opens the sessions `ImageLightbox`, presented from here so neither host has
 * to know about the viewer.
 */
export function IdeaFeedMedia({ urls }: { urls: ReadonlyArray<string> }) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState<string | null>(null);
  const tiles = feedMediaTiles(urls);
  if (tiles.length === 0) return null;

  return (
    <View style={styles.grid}>
      {tiles.map((tile) => (
        <Pressable
          accessibilityLabel={t("Open image")}
          accessibilityRole="imagebutton"
          key={`${tile.index}-${tile.url}`}
          onPress={() => setViewing(tile.url)}
          style={[
            styles.tile,
            tile.fullWidth ? styles.tileFull : styles.tileHalf,
            { height: tile.height },
          ]}
        >
          <Image resizeMode="cover" source={{ uri: tile.url }} style={styles.image} />
        </Pressable>
      ))}
      <ImageLightbox onClose={() => setViewing(null)} url={viewing} />
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  image: {
    height: "100%",
    width: "100%",
  },
  tile: {
    backgroundColor: hai.pebble,
    borderColor: hai.hairline,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  tileFull: {
    width: "100%",
  },
  tileHalf: {
    // Two per row with the 4pt gap between them.
    width: "49%",
    flexGrow: 1,
  },
});
