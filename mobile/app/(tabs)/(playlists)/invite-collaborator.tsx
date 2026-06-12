import { useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type CollaboratorRole } from "@music-library/core";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../components/form-field";
import { FormScreen } from "../../../components/form-screen";
import { HeaderTextButton } from "../../../components/header-buttons";
import { SegmentedControl } from "../../../components/segmented-control";
import { qk } from "../../../lib/query-keys";
import { useTheme } from "../../../theme/theme";

/**
 * Invite a user to collaborate on a playlist. Pushed from the collaborators
 * screen; takes the playlist id via query param because we
 * can't nest under `collaborators/[id]/` without restructuring `[id].tsx`.
 */
export default function InviteCollaboratorScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: playlistId } = useLocalSearchParams<{ id: string }>();

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");

  const inviteMutation = useMutation({
    mutationFn: () =>
      api.inviteCollaborator(playlistId!, {
        username: username.trim(),
        role,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: qk.playlistCollaborators(playlistId),
      });
      router.back();
    },
  });

  const canSubmit =
    !!playlistId && username.trim().length > 0 && !inviteMutation.isPending;

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
              label="Invite"
              disabled={!canSubmit}
              onPress={() => inviteMutation.mutate()}
            />
          ),
        }}
      />
      <FormScreen>
        <FormField label="Username">
          <FormTextInput
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="e.g. alice"
          />
        </FormField>

        <FormField
          label="Role"
          hint={
            role === "viewer"
              ? "Can play; cannot edit."
              : "Can play, add tracks, and reorder."
          }
        >
          <SegmentedControl<CollaboratorRole>
            options={[
              { label: "Viewer", value: "viewer" },
              { label: "Editor", value: "editor" },
            ]}
            value={role}
            onChange={setRole}
          />
        </FormField>

        <FormError
          message={
            inviteMutation.isError
              ? errorMessage(inviteMutation.error, "Couldn't send invite.")
              : null
          }
        />
      </FormScreen>
    </>
  );
}
