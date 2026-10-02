import { buildTrackPatch, trackEditForm } from "@music-library/core/metadata-edit";
import { useState } from "react";
import {
  ScrollView,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import {
  api,
  ApiError,
  isLocalTrack,
  libraryChanged,
  trackActions,
  useAuth,
  useEditDraft,
  type TrackDetail,
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
import { EmptyState, retryAction } from "../../../../components/empty-state";

/**
 * Admin-only track metadata editor. Reached from the track context menu's
 * "Edit Metadata" action. Loads the track, lets an admin rewrite the same
 * fields the web edit dialog exposes, and PATCHes only what actually changed.
 */
export default function TrackEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const trackQuery = useQuery({
    queryKey: qk.track(userId, id),
    queryFn: ({ signal }) => api.getTrack(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const track = trackQuery.data;
  // The server only edits library tracks, and only for admins; a TIDAL track
  // reached by a stale link or deep link gets an explanation, not a form.
  const canEdit = track
    ? trackActions(track, { isAdmin: me?.role === "admin" }).editMetadata
    : false;

  if (trackQuery.isLoading) return <EmptyState fill loading />;
  if (trackQuery.isError || !track || !id) {
    return (
      <EmptyState
        fill
        selectable
        message="Couldn't load track."
        action={retryAction(trackQuery)}
      />
    );
  }
  if (!canEdit) {
    return (
      <>
        <Stack.Screen options={{ title: "Edit Track" }} />
        <EmptyState
          fill
          message={
            isLocalTrack(track)
              ? "Only admins can edit track metadata."
              : "Only tracks in the library can be edited. This one streams from TIDAL."
          }
        />
      </>
    );
  }
  return <TrackEditor key={track.id} id={id} track={track} />;
}

function TrackEditor({ id, track }: { id: string; track: TrackDetail }) {
  const theme = useTheme();
  const router = useRouter();
  // The save diffs against the copy the form was filled from: the cached
  // track can be older than the server's, and a refetch landing mid-edit must
  // not turn the fields the user left alone into changes.
  const { base, draft, setField } = useEditDraft(track, trackEditForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateTrack(id, buildTrackPatch(base, draft));
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
            value={draft.title}
            onChangeText={(value) => setField("title", value)}
            placeholder="Track title"
          />
        </FormField>
        <FormField
          label="Artists"
          hint="Comma-separated. First is the primary, rest are featured."
        >
          <FormTextInput
            value={draft.artists}
            onChangeText={(value) => setField("artists", value)}
            placeholder="Alice, Bob"
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Album" hint="Leave blank to detach from its album.">
          <FormTextInput
            value={draft.albumTitle}
            onChangeText={(value) => setField("albumTitle", value)}
            placeholder="Album title"
          />
        </FormField>
        <FormField
          label="Album artist"
          hint="Leave blank for compilations (Various Artists)."
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
          <View style={{ flex: 1 }}>
            <FormField label="Genre">
              <FormTextInput
                value={draft.genre}
                onChangeText={(value) => setField("genre", value)}
                placeholder="Genre"
              />
            </FormField>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: theme.space.md }}>
          <View style={{ flex: 1 }}>
            <FormField label="Track #">
              <FormTextInput
                value={draft.trackNo}
                onChangeText={(value) => setField("trackNo", value)}
                placeholder="1"
                keyboardType="number-pad"
              />
            </FormField>
          </View>
          <View style={{ flex: 1 }}>
            <FormField label="Disc #">
              <FormTextInput
                value={draft.discNo}
                onChangeText={(value) => setField("discNo", value)}
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
