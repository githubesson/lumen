import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, useAuth, type Visibility } from "@music-library/core";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../../components/form-field";
import { FormScreen } from "../../../../components/form-screen";
import { HeaderTextButton } from "../../../../components/header-buttons";
import { SegmentedControl } from "../../../../components/segmented-control";
import { qk } from "../../../../lib/query-keys";
import { useTheme } from "../../../../theme/theme";

/**
 * Edit an existing playlist's metadata. Pushed from the detail screen and
 * hydrated once from the cached playlist query. `Save` / `Cancel`
 * live in the sheet's nav bar via `HeaderButton` so hit targets stay aligned
 * when the button swaps between label and spinner.
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
      setName(playlistQuery.data.name);
      setDescription(playlistQuery.data.description ?? "");
      setVisibility(playlistQuery.data.visibility);
      setHydrated(true);
    }
  }, [playlistQuery.data, hydrated]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updatePlaylist(id!, {
        name: name.trim(),
        description: description.trim(),
        visibility,
      }),
    onSuccess: () => {
      // User-scoped keys so the list and the detail screen both pick up the
      // edited name / description / visibility instead of staying stale.
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
      void queryClient.invalidateQueries({ queryKey: qk.playlist(userId, id) });
      router.back();
    },
  });

  const canSubmit =
    hydrated &&
    name.trim().length > 0 &&
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
        ) : (
          <>
            <FormField label="Name">
              <FormTextInput
                placeholder="Playlist name"
                value={name}
                onChangeText={setName}
                returnKeyType="next"
              />
            </FormField>

            <FormField label="Description" optional>
              <FormTextInput
                placeholder="Add a description"
                value={description}
                onChangeText={setDescription}
                style={{ minHeight: 96, textAlignVertical: "top" }}
                multiline
              />
            </FormField>

            <FormField
              label="Visibility"
              hint={
                visibility === "private"
                  ? "Only you can see this playlist."
                  : "Invite others to add and reorder tracks."
              }
            >
              <SegmentedControl<Visibility>
                options={[
                  { label: "Private", value: "private" },
                  { label: "Collaborative", value: "collaborative" },
                ]}
                value={visibility}
                onChange={setVisibility}
              />
            </FormField>

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
