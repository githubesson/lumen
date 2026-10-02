import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  PixelRatio,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  errorMessage,
  playlistCoverSizeError,
  playlistCoverUrl,
  type Playlist,
} from "@music-library/core";
import { SecondaryButton } from "../buttons";
import { FormError, FormField } from "../form-field";
import { qk } from "../../lib/query-keys";
import { useTheme } from "../../theme/theme";

const PREVIEW_SIZE = 120;

/**
 * The owner's cover picker on the playlist edit screen. Like the album
 * editor's, changes upload at once rather than waiting for Save; the detail
 * screen and the playlists list pick them up through the query cache.
 */
export function PlaylistCoverField({
  playlist,
  userId,
}: {
  playlist: Playlist;
  userId: string | undefined;
}) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasCover = !!playlist.custom_cover;
  const previewUri = playlist.custom_cover
    ? playlistCoverUrl(
        playlist.id,
        playlist.custom_cover,
        Math.round(PREVIEW_SIZE * PixelRatio.get()),
      )
    : null;

  const run = async (change: () => Promise<Playlist>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await change();
      // Named outright: a removed cover is absent from the response, and a
      // spread would keep the old one.
      queryClient.setQueryData<Playlist>(qk.playlist(userId, playlist.id), (p) =>
        p ? { ...p, custom_cover: updated.custom_cover } : updated,
      );
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const pickAndUpload = async () => {
    if (busy) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        // Covers show square everywhere, so crop to square up front.
        allowsEditing: true,
        aspect: [1, 1],
        // A quality < 1 makes expo-image-picker re-encode to JPEG, so HEIC
        // photos from the iOS library arrive as something the server decodes.
        quality: 0.9,
      });
    } catch {
      setError("Couldn't open the photo library.");
      return;
    }
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    // The picker doesn't always know the size; the server checks it anyway.
    const tooLarge = playlistCoverSizeError(asset.fileSize);
    if (tooLarge) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(tooLarge);
      return;
    }
    await run(
      () =>
        api.setPlaylistCover(playlist.id, {
          uri: asset.uri,
          name: asset.fileName ?? "cover.jpg",
          type: asset.mimeType ?? "image/jpeg",
        }),
      "Cover upload failed.",
    );
  };

  const confirmRemove = () => {
    if (busy) return;
    Alert.alert(
      "Remove cover?",
      "The playlist will show its tracks' artwork again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            void run(
              () => api.removePlaylistCover(playlist.id),
              "Couldn't remove the cover.",
            ),
        },
      ],
    );
  };

  return (
    <FormField label="Cover">
      <View
        style={{ flexDirection: "row", gap: theme.space.md, alignItems: "center" }}
      >
        <View
          style={{
            width: PREVIEW_SIZE,
            height: PREVIEW_SIZE,
            borderRadius: theme.radius.md,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: theme.color.bgElev2,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={previewUri}
              transition={120}
            />
          ) : (
            <Text
              style={{
                color: theme.color.fgMuted,
                fontSize: 12,
                textAlign: "center",
                paddingHorizontal: theme.space.sm,
              }}
            >
              Track artwork
            </Text>
          )}
          {busy ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "rgba(0,0,0,0.35)",
                },
              ]}
            >
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1, gap: theme.space.sm }}>
          <SecondaryButton
            label={hasCover ? "Replace image" : "Choose image"}
            onPress={() => void pickAndUpload()}
            disabled={busy}
          />
          {hasCover ? (
            <SecondaryButton
              label="Remove image"
              onPress={confirmRemove}
              disabled={busy}
              destructive
            />
          ) : null}
        </View>
      </View>
      <FormError message={error} />
    </FormField>
  );
}
