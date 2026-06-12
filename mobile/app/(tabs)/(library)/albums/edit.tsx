import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import {
  albumCoverUrl,
  api,
  ApiError,
  libraryChanged,
  useAuth,
  type Album,
  type AlbumPatch,
} from "@music-library/core";
import {
  PrimaryButton,
  SecondaryButton,
} from "../../../../components/buttons";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../../components/form-field";
import { Card } from "../../../../components/primitives";
import { HeaderSaveButton } from "../../../../components/header-buttons";
import { qk } from "../../../../lib/query-keys";
import { useTheme } from "../../../../theme/theme";

const COVER_PREVIEW_SIZE = 120;

/**
 * Admin-only album editor: metadata fields plus cover-art replace/remove.
 * Cover changes apply immediately (they're a multipart upload, separate from
 * the metadata PATCH); the metadata form is saved with the header "Save"
 * button. Reached from the album screen's header and the track context menu.
 */
export default function AlbumEditScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const albumQuery = useQuery({
    queryKey: qk.album(userId, id),
    queryFn: ({ signal }) => api.getAlbum(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const album = albumQuery.data;

  const [title, setTitle] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [year, setYear] = useState("");
  const [isCompilation, setIsCompilation] = useState(false);
  const [hasCover, setHasCover] = useState(false);
  // Cache-busts the cover preview <img> — the cover URL is stable even when
  // the underlying image is replaced.
  const [coverNonce, setCoverNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form once the album loads. Keyed on the album id so a background
  // refetch of the same album doesn't clobber in-progress edits.
  useEffect(() => {
    if (!album) return;
    setTitle(album.title);
    setAlbumArtist(album.artist_name ?? "");
    setYear(album.release_year ? String(album.release_year) : "");
    setIsCompilation(album.is_compilation);
    setHasCover(album.has_cover);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [album?.id]);

  // Push an updated album back into the caches the album screen reads, and
  // bump the shared cover-bust entry so its <Image> reloads the new artwork.
  const applyAlbumUpdate = useCallback(
    (updated: Album) => {
      const nonce = Date.now();
      setHasCover(updated.has_cover);
      setCoverNonce(nonce);
      // Update this album + its cover-bust nonce immediately so the album
      // screen underneath reflects the change without a flash; the
      // libraryChanged subscriber handles refreshing the album list and the
      // rest of the library.
      queryClient.setQueryData(qk.album(userId, id), updated);
      queryClient.setQueryData(qk.albumCoverBust(id), nonce);
      libraryChanged.emit();
    },
    [queryClient, userId, id],
  );

  const pickAndUploadCover = async () => {
    if (coverBusy || !id) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
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
    setCoverBusy(true);
    setError(null);
    try {
      const updated = await api.setAlbumCover(id, {
        uri: asset.uri,
        name: asset.fileName ?? "cover.jpg",
        type: asset.mimeType ?? "image/jpeg",
      });
      applyAlbumUpdate(updated);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(messageFor(err, "Cover upload failed."));
    } finally {
      setCoverBusy(false);
    }
  };

  const confirmRemoveCover = () => {
    if (coverBusy || !id) return;
    Alert.alert(
      "Remove cover art?",
      "The album will fall back to the placeholder artwork.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setCoverBusy(true);
              setError(null);
              try {
                const updated = await api.removeAlbumCover(id);
                applyAlbumUpdate(updated);
                void Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Success,
                );
              } catch (err) {
                void Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Error,
                );
                setError(messageFor(err, "Couldn't remove the cover."));
              } finally {
                setCoverBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const onSave = async () => {
    if (!id || !album || saving) return;
    setSaving(true);
    setError(null);
    try {
      const patch = buildPatch(album, { title, albumArtist, year, isCompilation });
      const updated = await api.updateAlbum(id, patch);
      applyAlbumUpdate(updated);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(messageFor(err, "Save failed."));
      setSaving(false);
    }
  };

  if (albumQuery.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <ActivityIndicator color={theme.color.fgMuted} />
      </View>
    );
  }
  if (albumQuery.isError || !album) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <Text style={{ color: theme.color.fgMuted }}>
          Couldn&apos;t load album.
        </Text>
      </View>
    );
  }

  const coverUri =
    hasCover && id
      ? `${albumCoverUrl(id, COVER_PREVIEW_SIZE * 3)}${coverNonce ? `&v=${coverNonce}` : ""}`
      : null;

  return (
    <>
      <Stack.Screen
        options={{
          title: "Edit Album",
          headerRight: () => (
            <HeaderSaveButton saving={saving} onPress={() => void onSave()} />
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.color.bg }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.lg,
        }}
      >
        <FormField label="Cover art">
          <View
            style={{
              flexDirection: "row",
              gap: theme.space.md,
              alignItems: "center",
            }}
          >
            <View
              style={{
                width: COVER_PREVIEW_SIZE,
                height: COVER_PREVIEW_SIZE,
                borderRadius: theme.radius.md,
                borderCurve: "continuous",
                overflow: "hidden",
                backgroundColor: theme.color.bgElev2,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {coverUri ? (
                <Image
                  source={{ uri: coverUri }}
                  style={{ width: "100%", height: "100%" }}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={coverUri}
                  transition={120}
                />
              ) : (
                <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
                  No cover
                </Text>
              )}
              {coverBusy ? (
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
                label={hasCover ? "Replace cover" : "Upload cover"}
                onPress={() => void pickAndUploadCover()}
                disabled={coverBusy}
              />
              {hasCover ? (
                <SecondaryButton
                  label="Remove cover"
                  onPress={confirmRemoveCover}
                  disabled={coverBusy}
                  destructive
                />
              ) : null}
            </View>
          </View>
        </FormField>

        <FormField label="Title">
          <FormTextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Album title"
          />
        </FormField>
        <FormField
          label="Album artist"
          hint="Leave blank and turn on Compilation for Various Artists."
        >
          <FormTextInput
            value={albumArtist}
            onChangeText={setAlbumArtist}
            placeholder="Album artist"
            autoCapitalize="words"
          />
        </FormField>
        <View style={{ flexDirection: "row", gap: theme.space.md }}>
          <View style={{ flex: 1 }}>
            <FormField label="Year">
              <FormTextInput
                value={year}
                onChangeText={setYear}
                placeholder="2024"
                keyboardType="number-pad"
              />
            </FormField>
          </View>
          <Card
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: theme.space.sm,
              paddingHorizontal: 14,
              alignSelf: "flex-end",
              height: 46,
            }}
          >
            <Text style={{ color: theme.color.fg, fontSize: 15 }}>
              Compilation
            </Text>
            <Switch
              value={isCompilation}
              onValueChange={setIsCompilation}
              trackColor={{ true: theme.color.accent }}
            />
          </Card>
        </View>

        <FormError message={error} />

        <PrimaryButton
          label="Save changes"
          onPress={() => void onSave()}
          loading={saving}
          accessibilityLabel="Save album metadata"
        />
      </ScrollView>
    </>
  );
}

/**
 * Diff the form against the loaded album and return only the changed fields,
 * mirroring the web edit dialog so the server PATCH stays minimal.
 */
function buildPatch(
  album: Album,
  form: {
    title: string;
    albumArtist: string;
    year: string;
    isCompilation: boolean;
  },
): AlbumPatch {
  const patch: AlbumPatch = {};
  const title = form.title.trim();
  if (title && title !== album.title) patch.title = title;
  const albumArtist = form.albumArtist.trim();
  if (albumArtist !== (album.artist_name ?? "")) {
    patch.album_artist = albumArtist;
  }
  const year = parseInt(form.year || "0", 10) || 0;
  if ((album.release_year ?? 0) !== year) patch.release_year = year;
  if (form.isCompilation !== album.is_compilation) {
    patch.is_compilation = form.isCompilation;
  }
  return patch;
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
