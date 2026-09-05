import { useState } from "react";
import { Stack, useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, useAuth, type Visibility } from "@music-library/core";
import {
  FormError,
} from "../../../components/form-field";
import { FormScreen } from "../../../components/form-screen";
import { HeaderTextButton } from "../../../components/header-buttons";
import { PlaylistFields } from "../../../components/playlist-fields";
import { qk } from "../../../lib/query-keys";
import { useTheme } from "../../../theme/theme";

/**
 * Create a new playlist from the playlists list.
 * On success, replaces to the new playlist's detail so Back lands back on
 * the list rather than re-presenting this form.
 */
export default function NewPlaylistScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const userId = me?.id;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");

  const createMutation = useMutation({
    mutationFn: () =>
      api.createPlaylist({
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
      }),
    onSuccess: (playlist) => {
      // Must match the user-scoped key the playlists list reads under, or the
      // new playlist never appears until a manual refresh.
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
      router.replace({
        pathname: "/(tabs)/(playlists)/[id]",
        params: { id: playlist.id },
      });
    },
  });

  const canSubmit = name.trim().length > 0 && !createMutation.isPending;

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
              label="Create"
              disabled={!canSubmit}
              onPress={() => createMutation.mutate()}
            />
          ),
        }}
      />
      <FormScreen>
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
            createMutation.isError
              ? errorMessage(createMutation.error, "Couldn't create playlist.")
              : null
          }
        />
      </FormScreen>
    </>
  );
}
