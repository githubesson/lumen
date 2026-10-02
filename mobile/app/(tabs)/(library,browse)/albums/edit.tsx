import { albumEditForm, buildAlbumPatch } from "@music-library/core/metadata-edit";
import { useCallback, useState } from "react";
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
  errorMessage,
  libraryChanged,
  useAuth,
  useEditDraft,
  type Album,
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
import { EmptyState, retryAction } from "../../../../components/empty-state";

const COVER_PREVIEW_SIZE = 120;

/**
 * Admin-only album editor: metadata fields plus cover-art replace/remove.
 * Cover changes apply immediately (they're a multipart upload, separate from
 * the metadata PATCH); the metadata form is saved with the header "Save"
 * button. Reached from the album screen's header and the track context menu.
 */
export default function AlbumEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const albumQuery = useQuery({
    queryKey: qk.album(userId, id),
    queryFn: ({ signal }) => api.getAlbum(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const album = albumQuery.data;
  if (albumQuery.isLoading) return <EmptyState fill loading />;
  // Only without data: a failed background refetch keeps the last album, and
  // must not unmount the editor and its unsaved changes.
  if (!album || !id) {
    return (
      <EmptyState
        fill
        selectable
        message="Couldn't load album."
        action={retryAction(albumQuery)}
      />
    );
  }
  return <AlbumEditor key={album.id} id={id} album={album} />;
}

function AlbumEditor({ id, album }: { id: string; album: Album }) {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const userId = me?.id;

  // The save diffs against the copy the form was filled from: the cached
  // album can be older than the server's, and a refetch landing mid-edit must
  // not turn the fields the user left alone into changes.
  const { base, draft, setField } = useEditDraft(album, albumEditForm);
  // Cache-busts the cover preview <img> — the cover URL is stable even when
  // the underlying image is replaced.
  const [coverNonce, setCoverNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live, not part of the draft: cover changes apply immediately and write
  // the updated album into the cache.
  const hasCover = album.has_cover;

  // Push an updated album back into the caches the album screen reads, and
  // bump the shared cover-bust entry so its <Image> reloads the new artwork.
  const applyAlbumUpdate = useCallback(
    (updated: Album) => {
      const nonce = Date.now();
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
    if (coverBusy) return;
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
      setError(errorMessage(err, "Cover upload failed."));
    } finally {
      setCoverBusy(false);
    }
  };

  const confirmRemoveCover = () => {
    if (coverBusy) return;
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
                setError(errorMessage(err, "Couldn't remove the cover."));
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
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateAlbum(id, buildAlbumPatch(base, draft));
      applyAlbumUpdate(updated);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(errorMessage(err, "Save failed."));
      setSaving(false);
    }
  };

  const coverUri = hasCover
    ? albumCoverUrl(id, COVER_PREVIEW_SIZE * 3, coverNonce)
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
            value={draft.title}
            onChangeText={(value) => setField("title", value)}
            placeholder="Album title"
          />
        </FormField>
        <FormField
          label="Album artist"
          hint="Leave blank and turn on Compilation for Various Artists."
        >
          <FormTextInput
            value={draft.albumArtist}
            onChangeText={(value) => setField("albumArtist", value)}
            placeholder="Album artist"
            autoCapitalize="words"
          />
        </FormField>
        <View style={{ flexDirection: "row", gap: theme.space.md }}>
          <View style={{ flex: 1 }}>
            <FormField label="Year">
              <FormTextInput
                value={draft.year}
                onChangeText={(value) => setField("year", value)}
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
              value={draft.isCompilation}
              onValueChange={(value) => setField("isCompilation", value)}
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
