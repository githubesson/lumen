import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  errorMessage,
  isValidPlaylistName,
  playlistDetailsPayload,
  playlistPermissions,
  useAuth,
  type Visibility,
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
 * change. Pushed from the detail screen and hydrated once from the cached
 * playlist query. `Save` / `Cancel` live in the sheet's nav bar via
 * `HeaderButton` so hit targets stay aligned when the button swaps between
 * label and spinner.
 */
export default function EditPlaylistScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
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

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated && playlistQuery.data) {
      // Hydrate the edit draft exactly once from the queried playlist.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(playlistQuery.data.name);
      setDescription(playlistQuery.data.description ?? "");
      setVisibility(playlistQuery.data.visibility);
      setHydrated(true);
    }
  }, [playlistQuery.data, hydrated]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updatePlaylist(id!, playlistDetailsPayload({ name, description, visibility })),
    onSuccess: () => {
      // User-scoped keys so the list and the detail screen both pick up the
      // edited name / description / visibility instead of staying stale.
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
      void queryClient.invalidateQueries({ queryKey: qk.playlist(userId, id) });
      router.back();
    },
  });

  const playlist = playlistQuery.data;
  const permissions = playlistPermissions(playlist, me);
  // The detail screen only offers Edit to the owner, but the playlist may
  // have changed hands (or this screen been reached some other way) since.
  const forbidden = hydrated && !permissions.canEditDetails;

  const canSubmit =
    hydrated &&
    permissions.canEditDetails &&
    isValidPlaylistName(name) &&
    !saveMutation.isPending;

  return (
    <>
      <Stack.Screen
        options={{
          headerTransparent: false,
          headerStyle: { backgroundColor: theme.color.bg },
          contentStyle: { backgroundColor: theme.color.bg },
          headerLeft: () => (
            <HeaderTextButton label="Cancel" onPress={() => router.back()} />
          ),
          headerRight: () => (
            <HeaderTextButton
              label="Save"
              disabled={!canSubmit}
              onPress={() => saveMutation.mutate()}
            />
          ),
        }}
      />
      <FormScreen>
        {!hydrated ? (
          <View style={{ paddingVertical: 48, alignItems: "center" }}>
            <ActivityIndicator color={theme.color.fgMuted} />
          </View>
        ) : forbidden ? (
          <EmptyState message="Only the playlist's owner can edit its details." />
        ) : (
          <>
            {playlist && permissions.canChangeCover ? (
              <PlaylistCoverField playlist={playlist} userId={userId} />
            ) : null}
            <PlaylistFields
              name={name}
              description={description}
              visibility={visibility}
              setName={setName}
              setDescription={setDescription}
              setVisibility={setVisibility}
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
