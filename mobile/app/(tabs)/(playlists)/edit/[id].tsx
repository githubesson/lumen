import { ActivityIndicator, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  errorMessage,
  isValidPlaylistName,
  playlistDetailsForm,
  playlistDetailsPayload,
  playlistPermissions,
  samePlaylistDetails,
  useAuth,
  useEditDraft,
  type Playlist,
} from "@music-library/core";
import { EmptyState } from "../../../../components/empty-state";
import {
  FormError,
} from "../../../../components/form-field";
import { FormScreen } from "../../../../components/form-screen";
import { HeaderTextButton } from "../../../../components/header-buttons";
import { PlaylistFields } from "../../../../components/playlist-fields";
import { PlaylistCoverField } from "../../../../components/playlists/playlist-cover-field";
import { qk } from "../../../../lib/query-keys";
import { useTheme } from "../../../../theme/theme";

/**
 * Edit an existing playlist's metadata and cover, which only its owner may
 * change. Pushed from the detail screen and filled from the cached playlist
 * query. `Save` / `Cancel` live in the sheet's nav bar via `HeaderButton` so
 * hit targets stay aligned when the button swaps between label and spinner.
 */
export default function EditPlaylistScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  // Share the detail screen's cache key so opening Edit reuses the already
  // loaded playlist instead of refetching under a separate key.
  const playlistQuery = useQuery({
    queryKey: qk.playlist(userId, id),
    queryFn: ({ signal }) => api.getPlaylist(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const playlist = playlistQuery.data;
  if (!playlist || !id) {
    return (
      <>
        <EditPlaylistHeader canSubmit={false} onSave={() => {}} />
        <FormScreen>
          <View style={{ paddingVertical: 48, alignItems: "center" }}>
            <ActivityIndicator color={theme.color.fgMuted} />
          </View>
        </FormScreen>
      </>
    );
  }
  return <PlaylistEditor key={playlist.id} id={id} playlist={playlist} />;
}

function EditPlaylistHeader({
  canSubmit,
  onSave,
}: {
  canSubmit: boolean;
  onSave: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  return (
    <Stack.Screen
      options={{
        headerTransparent: false,
        headerStyle: { backgroundColor: theme.color.bg },
        contentStyle: { backgroundColor: theme.color.bg },
        headerLeft: () => (
          <HeaderTextButton label="Cancel" onPress={() => router.back()} />
        ),
        headerRight: () => (
          <HeaderTextButton label="Save" disabled={!canSubmit} onPress={onSave} />
        ),
      }}
    />
  );
}

function PlaylistEditor({ id, playlist }: { id: string; playlist: Playlist }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const userId = me?.id;

  // The playlist query is persisted to disk, so the form can open on details
  // older than the server's. Until the first edit a refetch refills it; after
  // that the save compares with what the form was filled from.
  const { base, draft, setField } = useEditDraft(playlist, playlistDetailsForm);

  const saveMutation = useMutation({
    mutationFn: () => api.updatePlaylist(id, playlistDetailsPayload(draft)),
    onSuccess: () => {
      // User-scoped keys so the list and the detail screen both pick up the
      // edited name / description / visibility instead of staying stale.
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
      void queryClient.invalidateQueries({ queryKey: qk.playlist(userId, id) });
      router.back();
    },
  });

  const onSave = () => {
    // The request sends every field, so an unchanged form sends nothing
    // rather than write the details it opened with over newer ones.
    if (samePlaylistDetails(playlistDetailsForm(base), draft)) {
      router.back();
      return;
    }
    saveMutation.mutate();
  };

  const permissions = playlistPermissions(playlist, me);
  // The detail screen only offers Edit to the owner, but the playlist may
  // have changed hands (or this screen been reached some other way) since.
  const forbidden = !permissions.canEditDetails;

  const canSubmit =
    permissions.canEditDetails &&
    isValidPlaylistName(draft.name) &&
    !saveMutation.isPending;

  return (
    <>
      <EditPlaylistHeader canSubmit={canSubmit} onSave={onSave} />
      <FormScreen>
        {forbidden ? (
          <EmptyState message="Only the playlist's owner can edit its details." />
        ) : (
          <>
            {permissions.canChangeCover ? (
              <PlaylistCoverField playlist={playlist} userId={userId} />
            ) : null}
            <PlaylistFields
              name={draft.name}
              description={draft.description}
              visibility={draft.visibility}
              setName={(value) => setField("name", value)}
              setDescription={(value) => setField("description", value)}
              setVisibility={(value) => setField("visibility", value)}
            />

            <FormError
              message={
                saveMutation.isError
                  ? errorMessage(saveMutation.error, "Couldn't save playlist.")
                  : null
              }
            />
          </>
        )}
      </FormScreen>
    </>
  );
}
