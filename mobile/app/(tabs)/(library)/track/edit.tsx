import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import {
  api,
  ApiError,
  libraryChanged,
  useAuth,
  type TrackDetail,
  type TrackPatch,
} from "@music-library/core";
import { PrimaryButton } from "../../../../components/buttons";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../../components/form-field";
import { HeaderSaveButton } from "../../../../components/header-buttons";
import { qk } from "../../../../lib/query-keys";
import { useTheme } from "../../../../theme/theme";

/**
 * Admin-only track metadata editor. Reached from the track context menu's
 * "Edit Metadata" action. Loads the track, lets an admin rewrite the same
 * fields the web edit dialog exposes, and PATCHes only what actually changed.
 */
export default function TrackEditScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const trackQuery = useQuery({
    queryKey: qk.track(userId, id),
    queryFn: ({ signal }) => api.getTrack(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const track = trackQuery.data;

  const [title, setTitle] = useState("");
  const [artists, setArtists] = useState("");
  const [albumTitle, setAlbumTitle] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [year, setYear] = useState("");
  const [genre, setGenre] = useState("");
  const [trackNo, setTrackNo] = useState("");
  const [discNo, setDiscNo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form once the track loads. Keyed on the track id so navigating
  // between edit screens re-seeds, but a background refetch of the same track
  // doesn't clobber in-progress edits.
  useEffect(() => {
    if (!track) return;
    setTitle(track.title);
    setArtists(
      track.artists
        .filter((a) => a.role !== "composer")
        .map((a) => a.name)
        .join(", "),
    );
    setAlbumTitle(track.album_title ?? "");
    setAlbumArtist("");
    setYear(track.year ? String(track.year) : "");
    setGenre(track.genre ?? "");
    setTrackNo(track.track_no ? String(track.track_no) : "");
    setDiscNo(track.disc_no ? String(track.disc_no) : "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  const onSave = async () => {
    if (!id || !track || saving) return;
    setSaving(true);
    setError(null);
    try {
      const patch = buildPatch(track, {
        title,
        artists,
        albumTitle,
        albumArtist,
        year,
        genre,
        trackNo,
        discNo,
      });
      await api.updateTrack(id, patch);
      // The root layout's libraryChanged subscriber invalidates the browse
      // lists and every user-scoped query, so emitting is the whole refresh.
      libraryChanged.emit();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Save failed.",
      );
      setSaving(false);
    }
  };

  if (trackQuery.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <ActivityIndicator color={theme.color.fgMuted} />
      </View>
    );
  }
  if (trackQuery.isError || !track) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <Text style={{ color: theme.color.fgMuted }}>
          Couldn&apos;t load track.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "Edit Track",
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
        <FormField label="Title">
          <FormTextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Track title"
          />
        </FormField>
        <FormField
          label="Artists"
          hint="Comma-separated. First is the primary, rest are featured."
        >
          <FormTextInput
            value={artists}
            onChangeText={setArtists}
            placeholder="Alice, Bob"
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Album" hint="Leave blank to detach from its album.">
          <FormTextInput
            value={albumTitle}
            onChangeText={setAlbumTitle}
            placeholder="Album title"
          />
        </FormField>
        <FormField
          label="Album artist"
          hint="Leave blank for compilations (Various Artists)."
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
          <View style={{ flex: 1 }}>
            <FormField label="Genre">
              <FormTextInput
                value={genre}
                onChangeText={setGenre}
                placeholder="Genre"
              />
            </FormField>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: theme.space.md }}>
          <View style={{ flex: 1 }}>
            <FormField label="Track #">
              <FormTextInput
                value={trackNo}
                onChangeText={setTrackNo}
                placeholder="1"
                keyboardType="number-pad"
              />
            </FormField>
          </View>
          <View style={{ flex: 1 }}>
            <FormField label="Disc #">
              <FormTextInput
                value={discNo}
                onChangeText={setDiscNo}
                placeholder="1"
                keyboardType="number-pad"
              />
            </FormField>
          </View>
        </View>

        <FormError message={error} />

        <PrimaryButton
          label="Save changes"
          onPress={() => void onSave()}
          loading={saving}
          accessibilityLabel="Save track metadata"
        />
      </ScrollView>
    </>
  );
}

/**
 * Diff the form against the loaded track and return only the fields that
 * actually changed — mirrors the web edit dialog so the server PATCH stays
 * minimal. An untouched album-artist field is never sent (it isn't part of
 * TrackDetail, so there's nothing to compare it against).
 */
function buildPatch(
  track: TrackDetail,
  form: {
    title: string;
    artists: string;
    albumTitle: string;
    albumArtist: string;
    year: string;
    genre: string;
    trackNo: string;
    discNo: string;
  },
): TrackPatch {
  const patch: TrackPatch = {};
  const title = form.title.trim();
  if (title && title !== track.title) patch.title = title;

  const parsedArtists = form.artists
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const currentArtists = track.artists
    .filter((a) => a.role !== "composer")
    .map((a) => a.name);
  if (parsedArtists.join(" ") !== currentArtists.join(" ")) {
    patch.artists = parsedArtists;
  }

  const albumTitle = form.albumTitle.trim();
  if (albumTitle !== (track.album_title ?? "")) patch.album_title = albumTitle;
  const albumArtist = form.albumArtist.trim();
  if (albumArtist !== "") patch.album_artist = albumArtist;

  const year = parseInt(form.year || "0", 10) || 0;
  if ((track.year ?? 0) !== year) patch.year = year;

  const genre = form.genre.trim();
  if ((track.genre ?? "") !== genre) patch.genre = genre;

  const tn = parseInt(form.trackNo || "0", 10) || 0;
  if ((track.track_no ?? 0) !== tn) patch.track_no = tn;
  const dn = parseInt(form.discNo || "0", 10) || 0;
  if ((track.disc_no ?? 0) !== dn) patch.disc_no = dn;

  return patch;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
