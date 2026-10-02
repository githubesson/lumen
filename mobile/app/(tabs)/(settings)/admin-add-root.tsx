import { useState } from "react";
import { Stack, useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addMusicRootInput, api, errorMessage } from "@music-library/core";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../components/form-field";
import { FormScreen } from "../../../components/form-screen";
import { HeaderTextButton } from "../../../components/header-buttons";
import { qk } from "../../../lib/query-keys";
import { useTheme } from "../../../theme/theme";

export default function AdminAddRootScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");

  const input = addMusicRootInput(path, label);
  const createMutation = useMutation({
    mutationFn: (request: { path: string; label?: string }) =>
      api.addMusicRoot(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: qk.adminMusicRoots,
      });
      router.back();
    },
  });

  const canSubmit = input !== null && !createMutation.isPending;

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
              label="Add"
              disabled={!canSubmit}
              onPress={() => {
                if (input) createMutation.mutate(input);
              }}
            />
          ),
        }}
      />
      <FormScreen>
        <FormField label="Path" hint="Absolute path on the server">
          <FormTextInput
            value={path}
            onChangeText={setPath}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/music/library"
          />
        </FormField>

        <FormField label="Label" hint="Optional display name">
          <FormTextInput
            value={label}
            onChangeText={setLabel}
            placeholder="External drive"
          />
        </FormField>

        <FormError
          message={
            createMutation.isError
              ? errorMessage(createMutation.error, "Couldn't add root.")
              : null
          }
        />
      </FormScreen>
    </>
  );
}
